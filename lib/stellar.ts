import {
  Account,
  Asset,
  BASE_FEE,
  Claimant,
  Horizon,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

/**
 * HoldPay talks to Stellar testnet directly from the browser. There is no
 * server in this app: Horizon answers CORS for any origin, so the payment page
 * quotes, builds, signs and submits without a backend in the loop.
 */
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const EXPLORER_URL = "https://stellar.expert/explorer/testnet";

export const server = new Horizon.Server(HORIZON_URL);

/**
 * Canonical testnet USDC (Circle's issuer, home_domain centre.io). This is the
 * issuer Stellar's own docs use; a fresh testnet account needs a trustline
 * before it can hold any of it.
 */
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = new Asset("USDC", USDC_ISSUER);

/** How much more than the quote we are willing to spend, in percent. */
export const SLIPPAGE_PERCENT = 1;

/** Stellar keeps 7 decimal places. */
export function toStellarAmount(value: number): string {
  return value.toFixed(7);
}

export function shortAddress(address: string, lead = 6, tail = 6): string {
  if (address.length <= lead + tail + 3) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

export function isStellarAddress(value: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(value.trim());
}

/** The key we use to compare and group assets. `Asset.toString()` cannot collide. */
export function assetKey(asset: Asset): string {
  return asset.toString();
}

export interface HeldAsset {
  asset: Asset;
  key: string;
  code: string;
  /** Raw balance as reported by Horizon. */
  balance: number;
  /** What can actually be spent, after the XLM reserve for native. */
  spendable: number;
  isNative: boolean;
}

export interface AccountState {
  address: string;
  /** Base reserve + subentries + fee buffer, in XLM. Zero for non-native views. */
  minXlmReserve: number;
  held: HeldAsset[];
  /**
   * Whether the account has a USDC trustline at all. This cannot be read off
   * `held`: that list is filtered to positive balances, and a trustline that has
   * been opened but never funded holds exactly zero.
   */
  hasUsdc: boolean;
}

/**
 * A fresh Stellar account must keep a minimum XLM balance: 0.5 XLM base
 * reserve, plus 0.5 XLM per subentry (a trustline is a subentry). We keep an
 * extra 0.5 XLM so the account can still pay a fee after spending.
 */
export function minXlmReserve(subentryCount: number): number {
  return (2 + subentryCount) * 0.5 + 0.5;
}

function assetFromBalance(line: {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
}): Asset | null {
  if (line.asset_type === "native") return Asset.native();
  if (
    (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") &&
    line.asset_code &&
    line.asset_issuer
  ) {
    return new Asset(line.asset_code, line.asset_issuer);
  }
  // Pool shares and other exotic lines cannot be the source of a path payment.
  return null;
}

/** What the client holds and could pay with. */
export async function loadAccount(address: string): Promise<AccountState> {
  const account = await server.loadAccount(address);
  const reserve = minXlmReserve(account.subentry_count ?? 0);

  const held: HeldAsset[] = [];
  let hasUsdc = false;

  for (const line of account.balances) {
    // Checked before the balance filter below, so an opened-but-empty trustline
    // still counts as one.
    if (
      (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") &&
      line.asset_code === "USDC" &&
      (line as { asset_issuer?: string }).asset_issuer === USDC_ISSUER
    ) {
      hasUsdc = true;
    }

    const asset = assetFromBalance(line);
    if (!asset) continue;

    const balance = Number(line.balance);
    if (!Number.isFinite(balance) || balance <= 0) continue;

    const isNative = asset.isNative();
    const spendable = isNative ? balance - reserve : balance;
    if (spendable <= 0) continue;

    held.push({
      asset,
      key: assetKey(asset),
      code: isNative ? "XLM" : asset.getCode(),
      balance,
      spendable,
      isNative,
    });
  }

  // Native first — it is what a testnet wallet almost always has.
  held.sort((a, b) => (a.isNative === b.isNative ? b.balance - a.balance : a.isNative ? -1 : 1));

  return { address, minXlmReserve: reserve, held, hasUsdc };
}

export interface Quote {
  /** The asset the client would spend. */
  sourceKey: string;
  sourceCode: string;
  /** Amount of the source asset the path consumes. */
  sourceAmount: number;
  /** The exact amount of USDC the freelancer receives. */
  destAmount: number;
  /** Assets swapped through, excluding source and destination. */
  path: Asset[];
  /** Source amount plus slippage headroom — what we authorise as sendMax. */
  sendMax: number;
  /** Units of the source asset per 1 USDC. */
  rate: number;
}

type PathRecord = {
  source_asset_type: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount: string;
  destination_amount: string;
  path: { asset_type: string; asset_code?: string; asset_issuer?: string }[];
};

function pathRecordToKey(record: PathRecord): string {
  if (record.source_asset_type === "native") return "native";
  return `${record.source_asset_code}:${record.source_asset_issuer}`;
}

function pathRecordPath(record: PathRecord): Asset[] {
  const out: Asset[] = [];
  for (const hop of record.path ?? []) {
    const asset = assetFromBalance(hop);
    if (asset) out.push(asset);
  }
  return out;
}

/**
 * Ask Horizon what it would cost to deliver exactly `destAmount` USDC from each
 * of the assets the client holds. One request for all of them.
 *
 * Assets with no route come back missing — that is reported to the page as
 * "no path", never as a guessed rate.
 */
export async function quoteAll(
  held: HeldAsset[],
  destAmount: number,
): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (held.length === 0 || !(destAmount > 0)) return out;

  const sources = held.map((h) => h.asset);
  const amount = toStellarAmount(destAmount);

  let records: PathRecord[];
  try {
    const page = await server.strictReceivePaths(sources, USDC, amount).call();
    records = (page.records ?? []) as unknown as PathRecord[];
  } catch {
    // A network or Horizon failure is not a quote. Report nothing.
    return out;
  }

  for (const record of records) {
    const key = pathRecordToKey(record);
    const sourceAmount = Number(record.source_amount);
    if (!Number.isFinite(sourceAmount) || sourceAmount <= 0) continue;

    const alreadyHave = out.get(key);
    // Horizon can return several paths per source asset; keep the cheapest.
    if (alreadyHave && alreadyHave.sourceAmount <= sourceAmount) continue;

    out.set(key, {
      sourceKey: key,
      sourceCode: key === "native" ? "XLM" : (record.source_asset_code ?? "?"),
      sourceAmount,
      destAmount: Number(record.destination_amount),
      path: pathRecordPath(record),
      sendMax: sourceAmount * (1 + SLIPPAGE_PERCENT / 100),
      rate: sourceAmount / destAmount,
    });
  }

  return out;
}

export interface PaymentPlan {
  sourceAddress: string;
  destination: string;
  sendAsset: Asset;
  sendMax: string;
  destAmount: string;
  path: Asset[];
}

/** Build the path payment. The freelancer receives exactly `destAmount` USDC. */
export function buildPathPayment(plan: PaymentPlan, sequence: string): Transaction {
  const account = new Account(plan.sourceAddress, sequence);

  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: plan.sendAsset,
        sendMax: plan.sendMax,
        destination: plan.destination,
        destAsset: USDC,
        destAmount: plan.destAmount,
        path: plan.path,
      }),
    )
    .setTimeout(180);

  return builder.build();
}

/** Add the USDC trustline a freelancer needs before they can be paid. */
export function buildTrustline(address: string, sequence: string): Transaction {
  const account = new Account(address, sequence);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(180)
    .build();
}

/* ------------------------------------------------------------------------- *
 * The lock
 *
 * The price is not paid straight across. The client's transaction swaps
 * whatever they hold into USDC and then locks that exact amount in a claimable
 * balance destined to the freelancer, releasable back to the client after a
 * deadline the freelancer set. The freelancer claims it to be paid; if they
 * never do, the client takes it back.
 *
 * The lock is funded by the client, and it has to be: a claimable balance is
 * paid for out of its creator's own balance, and a freelancer setting up a link
 * holds no USDC — often not even a trustline. Naming a claimant costs nothing,
 * which is exactly why an account that cannot yet receive USDC can still be
 * paid this way.
 * ------------------------------------------------------------------------- */

export interface LockedPaymentPlan {
  /** The client. Funds the lock, and may reclaim it once the deadline passes. */
  sourceAddress: string;
  /** The freelancer. Claims the lock to be paid. */
  destination: string;
  sendAsset: Asset;
  sendMax: string;
  /** Exactly the price, in USDC. */
  destAmount: string;
  path: Asset[];
  /** Unix seconds. At or after this the client may reclaim. */
  deadline: number;
  /** The client has no USDC trustline yet and needs one to hold the swap. */
  addTrustline: boolean;
}

export interface BuiltLock {
  transaction: Transaction;
  /** Known before submitting — it derives from the transaction itself. */
  claimId: string;
}

/**
 * One transaction performs the whole payment: the path payment swaps the
 * client's asset into USDC **in their own account**, and the next operation
 * locks that exact USDC for the freelancer. Stellar applies the operations
 * atomically, so the swap cannot happen without the lock.
 */
export function buildLockedPayment(plan: LockedPaymentPlan, sequence: string): BuiltLock {
  const account = new Account(plan.sourceAddress, sequence);
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  // The swap credits the client with USDC for the instant before it is locked,
  // so the client needs the trustline too — not only the freelancer.
  if (plan.addTrustline) {
    builder.addOperation(Operation.changeTrust({ asset: USDC }));
  }

  builder.addOperation(
    Operation.pathPaymentStrictReceive({
      sendAsset: plan.sendAsset,
      sendMax: plan.sendMax,
      destination: plan.sourceAddress,
      destAsset: USDC,
      destAmount: plan.destAmount,
      path: plan.path,
    }),
  );

  const lockIndex = plan.addTrustline ? 2 : 1;

  builder.addOperation(
    Operation.createClaimableBalance({
      asset: USDC,
      amount: plan.destAmount,
      claimants: [
        new Claimant(plan.destination),
        new Claimant(
          plan.sourceAddress,
          Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(String(plan.deadline))),
        ),
      ],
    }),
  );

  const transaction = builder.setTimeout(180).build();
  return { transaction, claimId: transaction.getClaimableBalanceId(lockIndex) };
}

/**
 * Take a locked balance. The freelancer being paid and the client reclaiming an
 * expired lock are the same operation: the signer's address selects which
 * claimant they are, and the predicates decide whether it is allowed yet.
 */
export function buildClaim(claimId: string, claimant: string, sequence: string): Transaction {
  const account = new Account(claimant, sequence);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.claimClaimableBalance({ balanceId: claimId }))
    .setTimeout(180)
    .build();
}

export type LockStatus = "waiting" | "paid" | "returned";

export interface LockState {
  status: LockStatus;
  /** USDC the lock holds, or held. `null` when the id is not on the ledger. */
  amount: number | null;
  /** The freelancer the lock was destined to. */
  destination: string | null;
  /** The client whose payment funded it. */
  funder: string | null;
  /** Unix seconds after which the client may reclaim. */
  deadline: number | null;
  /** Who actually took it, once it has been taken. */
  claimedBy: string | null;
  /** The transaction that created the lock — the payment itself. */
  lockHash: string | null;
  /** The transaction that took it out again, whichever way it went. */
  claimHash: string | null;
}

type LockOp = {
  type: string;
  source_account?: string;
  amount?: string;
  transaction_hash?: string;
  claimants?: { destination: string; predicate: Record<string, unknown> }[];
};

/** Horizon spells this predicate `{ not: { abs_before_epoch } }`. */
function deadlineFromPredicate(predicate: Record<string, unknown> | undefined): number | null {
  const not = (predicate as { not?: { abs_before_epoch?: string } } | undefined)?.not;
  const epoch = not?.abs_before_epoch;
  return epoch ? Number(epoch) : null;
}

/**
 * Follow a lock through its whole life by reading the ledger. Horizon keeps a
 * balance's operation history even after the balance itself is claimed and
 * deleted, so this needs no database and assumes nothing from what this browser
 * happens to remember. An id with no create operation reads as `waiting` with a
 * null amount, which is how the page knows it is not on the ledger at all.
 */
export async function readLock(claimId: string): Promise<LockState> {
  const unknown: LockState = {
    status: "waiting",
    amount: null,
    destination: null,
    funder: null,
    deadline: null,
    claimedBy: null,
    lockHash: null,
    claimHash: null,
  };

  let ops: LockOp[];
  try {
    const page = await server.operations().forClaimableBalance(claimId).call();
    ops = page.records as unknown as LockOp[];
  } catch {
    return unknown;
  }

  const created = ops.find((op) => op.type === "create_claimable_balance");
  if (!created) return unknown;

  const amount = created.amount ? Number(created.amount) : null;
  const funder = created.source_account ?? null;

  // Both claimants are read by address rather than by position: the freelancer
  // is the one the lock pays, and the deadline belongs to the one who funded it.
  const claimants = created.claimants ?? [];
  const destination =
    claimants.find((claimant) => claimant.destination !== funder)?.destination ??
    claimants[0]?.destination ??
    null;
  const deadline = deadlineFromPredicate(
    (claimants.find((claimant) => claimant.destination === funder) ?? claimants[1])?.predicate,
  );
  const lockHash = created.transaction_hash ?? null;

  const claimed = ops.find((op) => op.type === "claim_claimable_balance");
  if (!claimed) {
    return {
      status: "waiting",
      amount,
      destination,
      funder,
      deadline,
      claimedBy: null,
      lockHash,
      claimHash: null,
    };
  }

  const claimedBy = claimed.source_account ?? null;
  // The freelancer taking it is the payment landing; the client taking it back
  // is the lock expiring unclaimed. Whoever signed the claim tells them apart.
  const status: LockStatus = destination && claimedBy === destination ? "paid" : "returned";

  return {
    status,
    amount,
    destination,
    funder,
    deadline,
    claimedBy,
    lockHash,
    claimHash: claimed.transaction_hash ?? null,
  };
}

/** Every lock still standing for a freelancer. Used instead of a database. */
export async function listOpenLocks(destination: string): Promise<string[]> {
  try {
    const page = await server.claimableBalances().claimant(destination).limit(50).call();
    return page.records.map((record) => record.id);
  } catch {
    return [];
  }
}

export async function nextSequence(address: string): Promise<string> {
  const account = await server.loadAccount(address);
  return account.sequenceNumber();
}

export async function submitSignedXdr(signedXdr: string) {
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  return server.submitTransaction(tx as Transaction);
}

export interface DestinationCheck {
  kind: "ok" | "missing" | "no-trustline" | "invalid" | "unknown";
  message: string;
  exists: boolean;
  hasUsdcTrustline: boolean;
  funded: boolean;
}

/** Can this address actually be paid USDC right now? */
export async function checkDestination(destination: string): Promise<DestinationCheck> {
  if (!isStellarAddress(destination)) {
    return {
      kind: "invalid",
      message: "That is not a valid Stellar address.",
      exists: false,
      hasUsdcTrustline: false,
      funded: false,
    };
  }

  try {
    const account = await server.loadAccount(destination);
    const trustline = account.balances.find(
      (line) =>
        (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") &&
        line.asset_code === "USDC" &&
        (line as { asset_issuer?: string }).asset_issuer === USDC_ISSUER,
    );

    if (!trustline) {
      return {
        kind: "no-trustline",
        message: "This account exists but has no USDC trustline, so it cannot receive USDC yet.",
        exists: true,
        hasUsdcTrustline: false,
        funded: true,
      };
    }

    return {
      kind: "ok",
      message: "Ready to receive USDC.",
      exists: true,
      hasUsdcTrustline: true,
      funded: true,
    };
  } catch (error) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status === 404) {
      return {
        kind: "missing",
        message: "This Stellar account does not exist yet. It needs to be created and funded first.",
        exists: false,
        hasUsdcTrustline: false,
        funded: false,
      };
    }
    return {
      kind: "unknown",
      message: "Could not reach Horizon to check this address.",
      exists: false,
      hasUsdcTrustline: false,
      funded: false,
    };
  }
}

export interface LandedPayment {
  hash: string;
  successful: boolean;
  /** USDC actually delivered to the destination, read back off the ledger. */
  delivered: number | null;
  /** The asset the payer actually spent. */
  spentCode: string | null;
  spentAmount: number | null;
}

/**
 * Read the payment back off the ledger. We show the delivered amount from the
 * operation record itself, so the receipt is the chain's number, not ours.
 */
export async function readLandedPayment(hash: string): Promise<LandedPayment> {
  const tx = await server.transactions().transaction(hash).call();
  const ops = await server.operations().forTransaction(hash).call();

  const payment = ops.records.find(
    (op) => op.type === "path_payment_strict_receive",
  ) as
    | {
        amount?: string;
        asset_code?: string;
        source_amount?: string;
        source_asset_type?: string;
        source_asset_code?: string;
      }
    | undefined;

  if (!payment) {
    return { hash, successful: tx.successful, delivered: null, spentCode: null, spentAmount: null };
  }

  const spentCode =
    payment.source_asset_type === "native" ? "XLM" : (payment.source_asset_code ?? null);

  return {
    hash,
    successful: tx.successful,
    delivered: payment.amount ? Number(payment.amount) : null,
    spentCode,
    spentAmount: payment.source_amount ? Number(payment.source_amount) : null,
  };
}

/** Stellar's error codes are precise but unfriendly — say what happened. */
export function explainSubmitError(error: unknown): string {
  const response = (
    error as {
      response?: {
        data?: {
          title?: string;
          detail?: string;
          extras?: { result_codes?: { transaction?: string; operations?: string[] } };
        };
      };
    }
  )?.response?.data;

  const opCodes = response?.extras?.result_codes?.operations ?? [];
  const txCode = response?.extras?.result_codes?.transaction;

  const known: Record<string, string> = {
    op_under_dest_min: "The rate moved before the payment landed. Nothing was sent — try again.",
    op_no_trust: "The receiving account has no USDC trustline, so it cannot accept this payment.",
    op_no_destination: "The receiving account does not exist on testnet yet.",
    op_underfunded: "Not enough balance to cover the payment plus the network reserve.",
    op_too_few_offers: "There is no longer a path between these assets.",
    op_cross_self: "That path would trade against your own offer.",
    op_line_full: "The receiving account's USDC trustline is full.",
    tx_insufficient_fee: "The network fee was too low.",
    tx_bad_seq: "The wallet's sequence number moved. Reconnect and try again.",
    tx_too_late: "The transaction expired before it was submitted. Try again.",
  };

  for (const code of opCodes) {
    if (known[code]) return known[code];
  }
  if (txCode && known[txCode]) return known[txCode];

  const detail = response?.detail ?? response?.title;
  if (detail) return detail;
  if (error instanceof Error && error.message) return error.message;
  return "The payment could not be submitted.";
}

/**
 * A worked example, kept so the page can show the real thing rather than a
 * diagram. These are three transactions on Stellar testnet, produced by
 * `scripts/e2e.mjs` — the same `lib/stellar.ts` the browser runs, with
 * generated keypairs standing in for the wallets.
 *
 *   lock    the client's single transaction: it swapped XLM into 5 USDC and
 *           locked that USDC in a claimable balance destined to the freelancer
 *   pay     the freelancer claimed the lock, which is the payment landing
 *   return  a second lock went unclaimed past its deadline, so the client took
 *           it back — same claim operation, different claimant
 *
 * Re-run `node scripts/e2e.mjs` to produce a fresh set; these will never be
 * edited by hand, and they are only ever shown next to the word testnet.
 */
export interface ProofStep {
  label: string;
  detail: string;
  hash: string;
}

export const WORKED_EXAMPLE: ProofStep[] = [
  {
    label: "Lock",
    detail: "the client's payment swapped into USDC and locked it for the freelancer",
    hash: "732508396e1d87e7d34338ac75aa8b14ad37e03ec100604f9f376b65eee20ba2",
  },
  {
    label: "Pay",
    detail: "the freelancer claimed the lock — the payment landing",
    hash: "bece397f9b992c8b8b9507623f3ea1afb85214f6d11fc1a016d68f543cbf91a5",
  },
  {
    label: "Return",
    detail: "an unclaimed lock went back to the client after its deadline",
    hash: "f17ffeed0002152c32fe451efde8e585c4bc7f356eed2f82efdbe6fbf5cc29d2",
  },
];

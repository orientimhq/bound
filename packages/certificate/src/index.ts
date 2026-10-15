/**
 * What the server adds to the verifier of @orientimhq/swap: the certificate a prepared swap carries
 * (certify), and the check of the transaction the wallet hands back (verifyWalletReturn).
 */
export { isLighthouseAssertion, LIGHTHOUSE_PROGRAM, MAX_ADDED_COMPUTE_UNITS, verifyWalletReturn } from './wallet.ts';
export { certificateJson, certify, VERIFIER_VERSION } from './certificate.ts';
export type { Certificate, Certification } from './certificate.ts';

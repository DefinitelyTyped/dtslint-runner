declare module "stats-lite" {
    /** @param percentile - ranges from 0.0 to 1.0 */
    export function percentile(ns: number[], percentile: number): number;
}

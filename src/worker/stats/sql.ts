/**
 * Matches `name:` stub ids through the primary-key index (SQLite's LIKE is
 * case-insensitive and can't use it). `name;` is the next ASCII string after
 * the `name:` prefix.
 */
export const STUB_SQL = (col: string) => `(${col} >= 'name:' AND ${col} < 'name;')`;

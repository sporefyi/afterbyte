/**
 * @afterbyte/database — schema barrel.
 *
 * Split by domain (core / research / auth / engagement / payments);
 * everything is re-exported here so drizzle-kit and consumers import one
 * module. Relations live in ../relations.js.
 */
export * from "./schema/_common.js";
export * from "./schema/auth.js";
export * from "./schema/core.js";
export * from "./schema/engagement.js";
export * from "./schema/payments.js";
export * from "./schema/research.js";

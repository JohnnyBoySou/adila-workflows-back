import { Redis } from "ioredis";
import { env } from "../config/env";

// BullMQ exige maxRetriesPerRequest: null na conexão.
export const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

import { drizzle } from "drizzle-orm/d1";
import { getEnv } from "./context";
import * as schema from "./schema";

export function getDb() {
  return drizzle(getEnv().DB, { schema });
}

export { schema };
export type Db = ReturnType<typeof getDb>;

import type { PrFile } from "@cfpa/contracts/api";

export interface PackFile {
  path: string;
  status: PrFile["status"];
  patch?: string;
}

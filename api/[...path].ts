import type { Request, Response } from "express";
import handler from "../index.js";

function restorePublicPath(req: Request): void {
  const url = req.url ?? "/";
  req.url = url
    .replace(/^\/api\/__spendseal_mcp(?=\/|\?|$)/, "/mcp")
    .replace(/^\/api\/__spendseal_oauth(?=\/|\?|$)/, "/oauth")
    .replace(/^\/api\/__spendseal_well_known(?=\/|\?|$)/, "/.well-known");
}

export default async function vercelRoute(req: Request, res: Response): Promise<void> {
  restorePublicPath(req);
  await handler(req, res);
}

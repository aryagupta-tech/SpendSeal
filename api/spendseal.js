import bundle from "../.vercel-build/index.cjs";
const handler = bundle.default ?? bundle;

export default async function vercelRoute(req, res) {
  const url = new URL(req.url ?? "/", "http://spendseal.internal");
  const publicPath = url.searchParams.get("__spendseal_path");
  if (publicPath) {
    url.searchParams.delete("__spendseal_path");
    const query = url.searchParams.toString();
    req.url = `${publicPath}${query ? `?${query}` : ""}`;
  }
  await handler(req, res);
}

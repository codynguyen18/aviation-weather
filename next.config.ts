import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Keep server-only CJS libraries unbundled: bundling postgres.js can split
  // it into multiple module copies whose instanceof checks (Parameter/json
  // helpers) fail across chunks, corrupting query serialization.
  serverExternalPackages: ["postgres", "pino"],
};

export default nextConfig;

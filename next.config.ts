import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin Turbopack's workspace root to this project. Otherwise Next infers it
  // from the nearest lockfile and warns when a parent dir also has one.
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;

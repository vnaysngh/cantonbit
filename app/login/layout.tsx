/** Skip static prerender — login needs Supabase only in the browser. */
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}

/**
 * Login layout — no TopNav, full-screen centered.
 * Overrides the root layout shell for unauthenticated pages.
 */
export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4">
      {children}
    </div>
  );
}

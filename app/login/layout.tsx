/**
 * Login layout — no TopNav, full-screen centered (stitch_minimal wireframe).
 */
export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen flex-col bg-background text-on-background selection:bg-primary-container selection:text-on-primary-container">
      {/* Atmospheric blurs — mobile wireframe */}
      <div
        aria-hidden
        className="pointer-events-none fixed top-[-10%] right-[-5%] z-0 h-[400px] w-[400px] rounded-full bg-primary/5 blur-[120px]"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed bottom-[-10%] left-[-5%] z-0 h-[350px] w-[350px] rounded-full bg-tertiary/5 blur-[100px]"
      />
      <main className="relative z-10 flex flex-grow items-center justify-center px-md py-xl md:py-xl">
        {children}
      </main>
    </div>
  );
}

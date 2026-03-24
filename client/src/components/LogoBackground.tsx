import logoPath from "@/assets/logo.jpg";

export function LogoBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <div
        className="fixed inset-0 pointer-events-none z-0 flex items-center justify-between px-4"
        aria-hidden="true"
      >
        <img src={logoPath} alt="" className="w-32 opacity-[0.08]" />
        <img src={logoPath} alt="" className="w-32 opacity-[0.08]" />
      </div>
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}

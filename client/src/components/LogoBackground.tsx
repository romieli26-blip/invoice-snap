import logoPath from "@/assets/logo.jpg";

export function LogoBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <div
        className="fixed inset-0 pointer-events-none z-0 flex items-center justify-center"
        aria-hidden="true"
      >
        <img
          src={logoPath}
          alt=""
          className="w-80 opacity-[0.12]"
        />
      </div>
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}

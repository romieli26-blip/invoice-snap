import logoPath from "@/assets/logo.jpg";

export function LogoBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen">
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}

export function LogoHeader() {
  return (
    <img
      src={logoPath}
      alt="Jetsetter Capital"
      className="h-8 opacity-60"
    />
  );
}

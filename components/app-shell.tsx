"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Overview" },
  { href: "/profile", label: "My Profile" },
  { href: "/opportunities", label: "Scholarships" },
  { href: "/funding", label: "Funding Plan" },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex min-h-full flex-col bg-[#faf9f6] text-[#14213d]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
      >
        Skip to content
      </a>
      <header className="border-b border-[#e2e0d8] bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="text-base font-bold tracking-tight text-[#14213d] focus:outline-none focus:ring-2 focus:ring-[#2563eb] rounded">
            Scholarship Navigator
          </Link>
          <nav aria-label="Main navigation" className="flex flex-wrap gap-1">
            {navItems.map((item) => {
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[#2563eb] ${
                    active
                      ? "bg-[#14213d] text-white"
                      : "text-[#33415c] hover:bg-[#eef2fb] hover:text-[#14213d]"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <div id="main-content" className="flex flex-1 flex-col">
        {children}
      </div>
      <footer className="border-t border-[#e2e0d8] bg-white px-6 py-4 text-center text-xs text-[#5c677d]">
        Scholarship Navigator — data stays in this browser (local storage). No account or cloud sync.
      </footer>
    </div>
  );
}

export function StatusChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-[#dbe3f2] bg-[#eef2fb] px-3 py-1 text-xs font-medium text-[#24365e]">
      {label}: {value}
    </span>
  );
}

export const primaryButtonClass =
  "inline-flex h-12 items-center justify-center rounded-full bg-[#14213d] px-6 text-base font-medium text-white transition-colors hover:bg-[#24365e] focus:outline-none focus:ring-2 focus:ring-[#2563eb] disabled:cursor-not-allowed disabled:opacity-50";

export const secondaryButtonClass =
  "inline-flex h-12 items-center justify-center rounded-full border border-[#c9d4ea] bg-white px-6 font-medium text-[#14213d] transition-colors hover:bg-[#eef2fb] focus:outline-none focus:ring-2 focus:ring-[#2563eb]";

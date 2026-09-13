import { ChevronLeft } from "lucide-react";
import { Link } from "react-router-dom";
import type { ReactNode } from "react";

export function PageHeader({ title, backTo, children }: { title: string; backTo?: string; children?: ReactNode }) {
  return <header className="page-title-bar flex min-h-16 items-center gap-3 border-b border-edge">
    {backTo && <Link className="page-back-button" to={backTo} aria-label="Back"><ChevronLeft size={17} /></Link>}
    <h1 className="m-0 text-xl font-semibold">{title}</h1>
    {children && <div className="ml-auto">{children}</div>}
  </header>;
}

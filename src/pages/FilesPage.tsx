import { Upload, Search, Grid, List, MoreHorizontal, FileText, Image, FileSpreadsheet, File } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";

const files = [
  { name: "Q1 Financial Report.pdf", type: "pdf", size: "2.4 MB", modified: "Mar 19", company: "Thinker Holdings", icon: FileText },
  { name: "Marketing Assets.zip", type: "archive", size: "48.2 MB", modified: "Mar 18", company: "RankLocal", icon: File },
  { name: "Fleet Inventory.xlsx", type: "spreadsheet", size: "1.1 MB", modified: "Mar 17", company: "A1 Marine Care", icon: FileSpreadsheet },
  { name: "Product Photos", type: "folder", size: "124 MB", modified: "Mar 16", company: "Vitatee", icon: Image },
  { name: "Supplier Contracts", type: "folder", size: "8.7 MB", modified: "Mar 15", company: "MarineMecca", icon: FileText },
  { name: "Brand Guidelines.pdf", type: "pdf", size: "5.6 MB", modified: "Mar 14", company: "Thinker Holdings", icon: FileText },
  { name: "Team Org Chart.png", type: "image", size: "340 KB", modified: "Mar 13", company: "Thinker Holdings", icon: Image },
  { name: "Client Proposals", type: "folder", size: "22 MB", modified: "Mar 12", company: "RankLocal", icon: FileText },
];

const typeColors: Record<string, string> = {
  pdf: "bg-destructive/15 text-destructive",
  spreadsheet: "bg-success/15 text-success",
  image: "bg-accent/15 text-accent",
  folder: "bg-primary/15 text-primary",
  archive: "bg-warning/15 text-warning",
};

export default function FilesPage() {
  const [viewMode, setViewMode] = useState<"grid" | "list">("list");

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between opacity-0 animate-fade-in">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Files</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{files.length} files and folders</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]">
          <Upload className="w-4 h-4" />
          Upload
        </button>
      </div>

      <div className="flex items-center justify-between opacity-0 animate-fade-in" style={{ animationDelay: "80ms" }}>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input type="text" placeholder="Search files..." className="bg-secondary border-0 rounded-lg pl-8 pr-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50 w-64" />
        </div>
        <div className="flex bg-secondary rounded-lg p-0.5">
          <button onClick={() => setViewMode("list")} className={cn("p-1.5 rounded-md transition-colors", viewMode === "list" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>
            <List className="w-4 h-4" />
          </button>
          <button onClick={() => setViewMode("grid")} className={cn("p-1.5 rounded-md transition-colors", viewMode === "grid" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>
            <Grid className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden opacity-0 animate-fade-in" style={{ animationDelay: "160ms" }}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Name</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Size</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Modified</th>
              <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider px-4 py-3">Company</th>
              <th className="w-10"></th>
            </tr>
          </thead>
          <tbody>
            {files.map((f, i) => (
              <tr key={i} className="border-b border-border/50 last:border-b-0 hover:bg-secondary/30 transition-colors cursor-pointer">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", typeColors[f.type])}>
                      <f.icon className="w-4 h-4" />
                    </div>
                    <span className="text-sm font-medium text-foreground">{f.name}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{f.size}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{f.modified}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{f.company}</td>
                <td className="px-4 py-3">
                  <button className="p-1 rounded hover:bg-secondary transition-colors text-muted-foreground">
                    <MoreHorizontal className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

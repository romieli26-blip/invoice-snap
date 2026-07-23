import { useState, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { Camera, FileText, LogOut, Users, Download, CreditCard, Banknote, Building2, X, Trash2, Pencil, Loader2, ChevronLeft, ChevronRight, ChevronDown, DollarSign, Clock, UserPlus, UsersRound, Wallet, BookOpen, Megaphone, Sheet } from "lucide-react";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkforceReport } from "@/components/WorkforceReport";
import type { Invoice } from "@shared/schema";
import { LogoBackground, LogoHeader } from "@/components/LogoBackground";

interface EnrichedInvoice extends Invoice {
  submittedBy: string;
}

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

function authImgUrl(photoPath: string) {
  const token = getAuthToken();
  return `${API_BASE}${photoPath}${token ? `?token=${token}` : ""}`;
}

// Files whose contents the <img> tag can render directly
function isImagePath(photoPath: string | undefined | null): boolean {
  if (!photoPath) return false;
  const ext = photoPath.split(".").pop()?.toLowerCase().split("?")[0] || "";
  return ["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(ext);
}
// Pretty-print a cash transaction category value (e.g. "eod_cash_on_hand" →
// "End of Day - Cash on Hand"). Falls back to a snake-case-cleaned version for
// unknown values so legacy data still displays cleanly.
const CASH_CATEGORY_LABELS: Record<string, string> = {
  rental_income: "Rental Income",
  washer: "Washer",
  dryer: "Dryer",
  vending: "Vending",
  store_items: "Store Items",
  eod_cash_on_hand: "End of Day - Cash on Hand",
  other: "Other",
  bank_deposit: "Bank Deposit",
  item_purchased: "Item Purchased",
  contractor_pay: "Contractor Pay",
  check: "Check",
};
function formatCashCategory(cat: string | null | undefined): string {
  if (!cat) return "";
  if (CASH_CATEGORY_LABELS[cat]) return CASH_CATEGORY_LABELS[cat];
  return cat.replace(/_/g, " ").replace(/\b\w/g, s => s.toUpperCase());
}

function isPdfPath(photoPath: string | undefined | null): boolean {
  if (!photoPath) return false;
  return photoPath.toLowerCase().endsWith(".pdf");
}

// Property Manager Playbook button + dialog. Visible to managers, admins,
// and super_admins when a playbook PDF has been uploaded by an admin.
function PlaybookButton({ role }: { role: string | undefined }) {
  const [open, setOpen] = useState(false);
  const eligible = role === "manager" || role === "admin" || role === "super_admin";
  const { data: info } = useQuery<any>({
    queryKey: ["/api/playbook/info"],
    enabled: eligible,
  });
  if (!eligible || !info) return null;
  const token = getAuthToken();
  const previewUrl = `${API_BASE}/api/playbook/file?token=${token}`;
  const downloadUrl = `${API_BASE}/api/playbook/file?download=1&token=${token}`;
  return (
    <>
      {/* Doubled height + highlighted (yellow bg + amber accents) so it stands
         out as the first thing users see on the dashboard. */}
      <Button
        variant="outline"
        className="w-full h-20 text-base font-semibold gap-2 bg-amber-100 hover:bg-amber-200 border-2 border-amber-400 text-amber-900 shadow-sm dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-500"
        onClick={() => setOpen(true)}
        data-testid="button-playbook"
      >
        <BookOpen className="w-6 h-6" />
        Property Manager Playbook
      </Button>
      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-card rounded-lg max-w-md w-full p-5 space-y-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-950/40 flex items-center justify-center">
                  <BookOpen className="w-5 h-5 text-amber-600 dark:text-amber-400" />
                </div>
                <div>
                  <h3 className="font-semibold">Property Manager Playbook</h3>
                  <p className="text-xs text-muted-foreground">
                    {info.sizeMB ? `${info.sizeMB} MB` : ""}
                    {info.updatedAt ? ` · Updated ${new Date(info.updatedAt).toLocaleDateString()}` : ""}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              The Property Manager Playbook is a guide to running a Jetsetter property. Preview it in your browser or download it for offline use.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-1.5 h-10 rounded-md border text-sm font-medium hover:bg-accent"
                data-testid="link-playbook-preview"
              >
                <FileText className="w-4 h-4" />
                Preview
              </a>
              <a
                href={downloadUrl}
                className="flex items-center justify-center gap-1.5 h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90"
                data-testid="link-playbook-download"
              >
                <Download className="w-4 h-4" />
                Download
              </a>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Marketing button — visible to property managers, admins, and super_admins.
// For PMs who manage exactly one property with a Marketing URL set, it opens
// that URL directly. For PMs/admins covering multiple properties, it opens a
// small picker so they can choose which property's marketing page to visit.
// Hidden entirely when no property they manage has a URL configured.
//
// The Master Sheet button just below shares the same access model — PMs see
// their home-base link, admins/super_admins see every property that has a URL
// set. If you change one, mirror the change in the other.
function MarketingButton({ role, homeProperty, compact }: { role: string | undefined; homeProperty?: string | null; compact?: boolean }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const eligible = role === "manager" || role === "admin" || role === "super_admin";
  const isAdmin = role === "admin" || role === "super_admin";
  const { data: properties } = useQuery<any[]>({
    queryKey: ["/api/properties"],
    enabled: eligible,
  });
  if (!eligible || !properties) return null;

  // Property managers see the marketing link only for THEIR home base property.
  // Admins/super_admins still see every property that has a marketing URL set.
  const scoped = isAdmin
    ? properties
    : (homeProperty ? properties.filter(p => p.name === homeProperty) : []);
  const withUrl = scoped.filter(p => !!p.marketingUrl);
  if (withUrl.length === 0) return null;

  const handleClick = () => {
    if (withUrl.length === 1) {
      window.open(withUrl[0].marketingUrl, "_blank", "noopener,noreferrer");
    } else {
      setPickerOpen(true);
    }
  };

  return (
    <>
      <Button
        className={compact
          ? "w-full h-16 text-sm gap-1.5 bg-orange-500 hover:bg-orange-600 text-white flex-col leading-tight"
          : "w-full h-12 text-sm gap-1.5 bg-orange-500 hover:bg-orange-600 text-white"}
        onClick={handleClick}
        data-testid="button-marketing"
      >
        <Megaphone className={compact ? "w-5 h-5" : "w-4 h-4"} />
        Marketing
      </Button>
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="bg-card rounded-lg max-w-md w-full p-5 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-orange-100 dark:bg-orange-950/40 flex items-center justify-center">
                  <Megaphone className="w-4 h-4 text-orange-600 dark:text-orange-400" />
                </div>
                <h3 className="font-semibold">Marketing</h3>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPickerOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Choose a property:</p>
            <div className="space-y-2">
              {withUrl.map(p => (
                <a
                  key={p.id}
                  href={p.marketingUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border hover:bg-accent text-sm"
                  onClick={() => setPickerOpen(false)}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-[60%]">{p.marketingUrl}</span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Master Sheet button — same access model as MarketingButton. PMs see the link
// only for their home-base property; admins/super_admins see every property
// that has a `masterSheetUrl` set. If the user manages just one property with
// a URL, clicking opens it directly; otherwise a small picker lets them choose
// which property's sheet to open. Hidden entirely if no scoped property has a
// URL configured.
function MasterSheetButton({ role, homeProperty, compact }: { role: string | undefined; homeProperty?: string | null; compact?: boolean }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const eligible = role === "manager" || role === "admin" || role === "super_admin";
  const isAdmin = role === "admin" || role === "super_admin";
  const { data: properties } = useQuery<any[]>({
    queryKey: ["/api/properties"],
    enabled: eligible,
  });
  if (!eligible || !properties) return null;

  const scoped = isAdmin
    ? properties
    : (homeProperty ? properties.filter(p => p.name === homeProperty) : []);
  const withUrl = scoped.filter(p => !!p.masterSheetUrl);
  if (withUrl.length === 0) return null;

  const handleClick = () => {
    if (withUrl.length === 1) {
      window.open(withUrl[0].masterSheetUrl, "_blank", "noopener,noreferrer");
    } else {
      setPickerOpen(true);
    }
  };

  return (
    <>
      <Button
        className={compact
          ? "w-full h-16 text-sm gap-1.5 bg-blue-600 hover:bg-blue-700 text-white flex-col leading-tight"
          : "w-full h-12 text-sm gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"}
        onClick={handleClick}
        data-testid="button-master-sheet"
      >
        <Sheet className={compact ? "w-5 h-5" : "w-4 h-4"} />
        Master Sheet
      </Button>
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="bg-card rounded-lg max-w-md w-full p-5 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-950/40 flex items-center justify-center">
                  <Sheet className="w-4 h-4 text-blue-600 dark:text-blue-400" />
                </div>
                <h3 className="font-semibold">Master Sheet</h3>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setPickerOpen(false)}>
                <X className="w-4 h-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Choose a property:</p>
            <div className="space-y-2">
              {withUrl.map(p => (
                <a
                  key={p.id}
                  href={p.masterSheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-md border hover:bg-accent text-sm"
                  onClick={() => setPickerOpen(false)}
                >
                  <span className="font-medium">{p.name}</span>
                  <span className="text-xs text-muted-foreground truncate max-w-[60%]">{p.masterSheetUrl}</span>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// Compact thumbnail used in receipt cards. Shows the image when possible,
// or a labeled placeholder for PDFs and other non-image attachments.
// Receipt photo viewer with drag-to-pan in all directions (item 6 in June 2026 update).
// Uses pointer events so it works for mouse, touch and pen. The transform is
// applied via translate so panning is exactly under the cursor/finger.
function ZoomablePhoto({ src, zoom, onZoomChange }: { src: string; zoom: number; onZoomChange: (z: number) => void }) {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ startX: number; startY: number; baseX: number; baseY: number; pointerId: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Reset pan when zoom returns to 1.
  useEffect(() => {
    if (zoom === 1) setOffset({ x: 0, y: 0 });
  }, [zoom]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1) return;
    drag.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: offset.x, baseY: offset.y,
      pointerId: e.pointerId,
    };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag.current) return;
    setOffset({
      x: drag.current.baseX + (e.clientX - drag.current.startX),
      y: drag.current.baseY + (e.clientY - drag.current.startY),
    });
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current) {
      (e.target as Element).releasePointerCapture?.(drag.current.pointerId);
      drag.current = null;
    }
  }

  return (
    <>
      <div
        ref={wrapperRef}
        className="overflow-hidden max-h-[80vh] rounded-lg select-none"
        style={{
          cursor: zoom > 1 ? (drag.current ? "grabbing" : "grab") : "default",
          touchAction: zoom > 1 ? "none" : "auto",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={src}
          alt="Receipt"
          className="w-full rounded-lg transition-transform pointer-events-none"
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
            transformOrigin: "center center",
          }}
          onDoubleClick={() => onZoomChange(zoom === 1 ? 2.5 : 1)}
        />
      </div>
      {/* Zoom controls */}
      <div className="absolute top-2 left-2 flex gap-1">
        <button
          className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center text-lg font-bold"
          onClick={() => onZoomChange(Math.min(zoom + 0.5, 4))}
        >+</button>
        <button
          className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center text-lg font-bold"
          onClick={() => { onZoomChange(Math.max(zoom - 0.5, 1)); }}
        >-</button>
        {zoom > 1 && (
          <button
            className="h-8 px-2 rounded-full bg-black/50 text-white flex items-center justify-center text-xs"
            onClick={() => { onZoomChange(1); setOffset({ x: 0, y: 0 }); }}
          >Reset</button>
        )}
      </div>
    </>
  );
}

function PhotoThumb({ paths, onClick }: { paths: string[]; onClick: (e?: any) => void }) {
  const first = paths[0];
  const extra = paths.length > 1 ? paths.length : 0;
  const isPdf = isPdfPath(first);
  const isImg = isImagePath(first);
  return (
    <div
      className="w-12 h-12 rounded-lg bg-muted flex items-center justify-center flex-shrink-0 overflow-hidden cursor-pointer relative"
      onClick={(e) => { e.stopPropagation(); onClick(e); }}
    >
      {isImg ? (
        <img src={authImgUrl(first)} alt="Receipt" className="w-full h-full object-cover" />
      ) : isPdf ? (
        <div className="w-full h-full flex flex-col items-center justify-center bg-red-50 dark:bg-red-950/30">
          <FileText className="w-5 h-5 text-red-600 dark:text-red-400" />
          <span className="text-[8px] font-bold text-red-700 dark:text-red-300 mt-0.5">PDF</span>
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center">
          <FileText className="w-5 h-5 text-muted-foreground" />
          <span className="text-[7px] text-muted-foreground mt-0.5">FILE</span>
        </div>
      )}
      {extra > 1 && (
        <span className="absolute bottom-0 right-0 bg-black/60 text-white text-[8px] px-1 rounded-tl">{extra}</span>
      )}
    </div>
  );
}

export default function HistoryPage() {
  const { user, logout } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [viewingPhotos, setViewingPhotos] = useState<string[] | null>(null);
  const [viewPhotoIdx, setViewPhotoIdx] = useState(0);
  const [photoZoom, setPhotoZoom] = useState(1);
  const [editingInvoice, setEditingInvoice] = useState<EnrichedInvoice | null>(null);
  const [editDescription, setEditDescription] = useState("");
  const [editPurpose, setEditPurpose] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editBoughtBy, setEditBoughtBy] = useState("");
  const [editPaymentMethod, setEditPaymentMethod] = useState<"cash" | "cc">("cc");
  const [editLastFour, setEditLastFour] = useState("");
  const [editRmIssue, setEditRmIssue] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const { data: invoices, isLoading } = useQuery<EnrichedInvoice[]>({
    queryKey: ["/api/invoices"],
  });

  const { data: cashBalances } = useQuery<Record<string, number>>({
    queryKey: ["/api/cash-balances"],
  });

  // Checks on Hand: sum of un-deposited checks per property.
  const { data: checkBalances } = useQuery<Record<string, number>>({
    queryKey: ["/api/check-transactions/balances"],
  });

  const { data: cashTxs } = useQuery<any[]>({
    queryKey: ["/api/cash-transactions"],
  });

  const { data: checkTxs } = useQuery<any[]>({
    queryKey: ["/api/check-transactions"],
  });

  const { data: timeReports } = useQuery<any[]>({
    queryKey: ["/api/time-reports"],
  });

  const { data: workCredits } = useQuery<any[]>({
    queryKey: ["/api/work-credits"],
  });

  const { data: flatRates } = useQuery<any[]>({
    queryKey: ["/api/flat-rate-assignments"],
  });

  // ---- User filter (admins + PMs with managed properties) ----
  // Build list of distinct users who appear in any of the four lists.
  const [userFilter, setUserFilter] = useState<string>("all");
  // Property filter — visible to admin/super_admin only (item 8 in June 2026 update).
  const [propertyFilter, setPropertyFilter] = useState<string>("all");
  // Collapsible section state — Recent Receipts open by default, the rest collapsed for a cleaner page.
  const [showReceipts, setShowReceipts] = useState(true);
  const [showCashTxs, setShowCashTxs] = useState(false);
  const [showCheckTxs, setShowCheckTxs] = useState(false);
  // Deposit dialog state — captures the slip/confirmation photo at the
  // moment of marking a check deposited (mirrors the original check-photo step).
  const [depositingCheck, setDepositingCheck] = useState<any | null>(null);
  const [depositPhotoPath, setDepositPhotoPath] = useState("");
  const [depositPhotoPreview, setDepositPhotoPreview] = useState("");
  const [depositUploading, setDepositUploading] = useState(false);
  const [depositSaving, setDepositSaving] = useState(false);
  const depositCameraRef = useRef<HTMLInputElement | null>(null);
  const depositFileRef = useRef<HTMLInputElement | null>(null);
  const [showWorkReports, setShowWorkReports] = useState(false);
  const [showFlatRates, setShowFlatRates] = useState(false);
  const [showWorkCredits, setShowWorkCredits] = useState(false);

  const filterOptions = useMemo(() => {
    const set = new Map<number, string>();
    const add = (items: any[] | undefined) => {
      if (!items) return;
      for (const it of items) {
        if (it.userId && it.submittedBy) set.set(it.userId, it.submittedBy);
      }
    };
    add(invoices);
    add(cashTxs);
    add(timeReports);
    add(workCredits);
    add(flatRates);
    // Always include the viewer themselves
    if (user?.id && user?.displayName) set.set(user.id, user.displayName);
    return Array.from(set.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [invoices, cashTxs, timeReports, workCredits, flatRates, user?.id, user?.displayName]);

  // Show the filter only when there's more than one unique user represented.
  const showUserFilter = filterOptions.length > 1;

  // Distinct property values that appear in any list — used to populate the admin property filter.
  const propertyFilterOptions = useMemo(() => {
    const set = new Set<string>();
    const add = (items: any[] | undefined) => {
      if (!items) return;
      for (const it of items) if (it.property) set.add(it.property);
    };
    add(invoices);
    add(cashTxs);
    add(timeReports);
    add(workCredits);
    add(flatRates);
    return Array.from(set).sort();
  }, [invoices, cashTxs, timeReports, workCredits, flatRates]);

  const isAdminUser = user?.role === "admin" || user?.role === "super_admin";
  const showPropertyFilter = isAdminUser && propertyFilterOptions.length > 1;

  function matchesFilter(item: any): boolean {
    if (userFilter !== "all" && String(item.userId) !== userFilter) return false;
    if (propertyFilter !== "all" && item.property !== propertyFilter) return false;
    return true;
  }
  const filteredInvoices = useMemo(() => invoices?.filter(matchesFilter), [invoices, userFilter, propertyFilter]);
  const filteredCashTxs = useMemo(() => cashTxs?.filter(matchesFilter), [cashTxs, userFilter, propertyFilter]);
  const filteredCheckTxs = useMemo(() => checkTxs?.filter(matchesFilter), [checkTxs, userFilter, propertyFilter]);
  const filteredTimeReports = useMemo(() => timeReports?.filter(matchesFilter), [timeReports, userFilter, propertyFilter]);
  const filteredWorkCredits = useMemo(() => workCredits?.filter(matchesFilter), [workCredits, userFilter, propertyFilter]);
  const filteredFlatRates = useMemo(() => flatRates?.filter(matchesFilter), [flatRates, userFilter, propertyFilter]);

  // Cash transaction edit state
  // Full-text "details" modal. Clicking a truncated description opens this
  // (item 7 in June 2026 update).
  const [detailsModal, setDetailsModal] = useState<{ title: string; lines: { label: string; value: string }[] } | null>(null);
  const [editingCashTx, setEditingCashTx] = useState<any | null>(null);
  const [editCashAmount, setEditCashAmount] = useState("");
  const [editCashCategory, setEditCashCategory] = useState("");
  const [editCashDescription, setEditCashDescription] = useState("");
  const [editCashUnitLot, setEditCashUnitLot] = useState("");
  const [editCashTenantName, setEditCashTenantName] = useState("");
  const [editCashBankName, setEditCashBankName] = useState("");
  const [editCashSaving, setEditCashSaving] = useState(false);

  async function handleCashDelete(id: number) {
    if (!window.confirm("Delete this cash transaction?")) return;
    try {
      await apiRequest("DELETE", `/api/cash-transactions/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/cash-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/cash-balances"] });
      toast({ title: "Transaction deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  async function handleCashExport() {
    try {
      const res = await apiRequest("GET", "/api/cash-transactions/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "cash-transactions.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  }

  async function handleExport() {
    try {
      const res = await apiRequest("GET", "/api/invoices/export");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "receipts.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
    }
  }

  const deleteInvoiceMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiRequest("DELETE", `/api/invoices/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
    },
  });

  return (
    <LogoBackground>
      <div className="bg-background">
      {/* Header */}
      <div className="border-b bg-card px-4 py-3">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold" data-testid="text-history-title">Jetsetter Reporting</h1>
            <p className="text-xs text-muted-foreground">
              {user?.firstName && user?.lastName ? `${user.firstName} ${user.lastName}` : user?.displayName}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <LogoHeader />
            {(user?.role === "admin" || user?.role === "super_admin") && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setLocation("/admin")}
                data-testid="button-admin"
              >
                <Users className="w-5 h-5" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              data-testid="button-logout"
            >
              <LogOut className="w-5 h-5" />
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Property Manager Playbook (hidden for contractors and when no playbook is uploaded) */}
        <PlaybookButton role={user?.role} />

        {/* Action Buttons */}
        {user?.role !== "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              className="h-20 text-sm gap-1.5 flex-col leading-tight"
              onClick={() => setLocation("/capture")}
              data-testid="button-new-invoice"
            >
              <Camera className="w-6 h-6" />
              <span className="text-center">New Credit Card<br/>Receipt</span>
            </Button>
            <Button
              className="h-20 text-sm gap-1.5 flex-col leading-tight bg-orange-100 hover:bg-orange-200 text-orange-800 border border-orange-300"
              variant="outline"
              onClick={() => setLocation("/cash")}
              data-testid="button-cash-transaction"
            >
              <Camera className="w-6 h-6" />
              <span className="text-center">New Cash<br/>Transaction</span>
            </Button>
          </div>
        )}

        {(user?.role === "admin" || user?.role === "super_admin") && (
          <Button
            className="w-full h-12 bg-yellow-400 hover:bg-yellow-500 text-black gap-2"
            onClick={() => setLocation("/reconcile")}
          >
            <FileText className="w-5 h-5" />
            CC Statement Reconciliation
          </Button>
        )}

        {/* Row: New Check Transaction (full width). Marketing + Master Sheet
           share the next row so PMs get both quick-links side by side. Each
           of the link buttons hides itself if no property they manage has a
           URL set, in which case the row collapses gracefully. */}
        {user?.role !== "contractor" && (
          <Button
            className="w-full h-16 text-sm gap-1.5 flex-col leading-tight bg-emerald-100 hover:bg-emerald-200 text-emerald-800 border border-emerald-300"
            variant="outline"
            onClick={() => setLocation("/check")}
            data-testid="button-new-check"
          >
            <Camera className="w-5 h-5" />
            <span className="text-center">New Check Transaction</span>
          </Button>
        )}

        {user?.role !== "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <MarketingButton role={user?.role} homeProperty={(user as any)?.homeProperty} compact />
            <MasterSheetButton role={user?.role} homeProperty={(user as any)?.homeProperty} compact />
          </div>
        )}

        {/* For contractors, MarketingButton may still render full-width on its
           own (no Check submission for them). */}
        {user?.role === "contractor" && (
          <MarketingButton role={user?.role} homeProperty={(user as any)?.homeProperty} />
        )}

        {user?.role === "contractor" && (
          <div className="grid grid-cols-2 gap-3">
            <Button
              className="h-16 text-sm gap-1.5 flex-col leading-tight bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setLocation("/time-report")}
            >
              <Clock className="w-5 h-5" />
              Work Report
            </Button>
            <Button
              className={`h-16 text-sm gap-1.5 flex-col leading-tight ${(user as any)?.docsComplete ? "bg-green-100 hover:bg-green-200 text-green-800 border-green-300" : "bg-orange-100 hover:bg-orange-200 text-orange-800 border-orange-300"}`}
              variant="outline"
              onClick={() => setLocation("/documents")}
            >
              <FileText className="w-5 h-5" />
              My Documents
              {(user as any)?.docsComplete ? <span className="text-[10px]">Complete</span> : <span className="text-[10px]">Action needed</span>}
            </Button>
          </div>
        )}

        {user?.role === "contractor" && ((user as any)?.allowWorkCredits || false) && (
          <Button
            className="w-full h-12 text-sm gap-1.5 bg-purple-600 hover:bg-purple-700 text-white"
            onClick={() => setLocation("/work-credit")}
          >
            <CreditCard className="w-4 h-4" />
            Work Credit
          </Button>
        )}

        {user?.role === "contractor" && ((user as any)?.allowContractorDocs || false) && (
          <Button
            className="w-full h-12 text-sm gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
            onClick={() => setLocation("/contractor-documents")}
          >
            <UserPlus className="w-4 h-4" />
            Contractor Documents
          </Button>
        )}

        {/* Non-contractor buttons. For admins, each button is gated on an opt-in show* flag.
            For managers, the existing allow* flags determine visibility. */}
        {user?.role !== "contractor" && (() => {
          const isAdmin = user?.role === "admin" || user?.role === "super_admin";
          const showWorkReport = isAdmin ? !!(user as any)?.showWorkReport : true;
          const showMyDocs = isAdmin ? !!(user as any)?.showMyDocuments : true;
          const showWorkCredit = isAdmin ? !!(user as any)?.showWorkCredit : !!(user as any)?.allowWorkCredits;
          const showMyContractors = isAdmin ? !!(user as any)?.showMyContractors : !!(user as any)?.allowCreatingContractors;
          const showContractorDocs = !!(user as any)?.allowContractorDocs || isAdmin;
          return (
            <>
              {(showWorkReport || showMyDocs) && (
                <div className="grid grid-cols-2 gap-3">
                  {showWorkReport && (
                    <Button
                      className={`h-12 text-sm gap-1.5 bg-blue-600 hover:bg-blue-700 text-white ${!showMyDocs ? "col-span-2" : ""}`}
                      onClick={() => setLocation("/time-report")}
                    >
                      <Clock className="w-4 h-4" />
                      Work Report
                    </Button>
                  )}
                  {showMyDocs && (
                    <Button
                      className={`h-12 text-sm gap-1.5 ${(user as any)?.docsComplete ? "bg-green-100 hover:bg-green-200 text-green-800 border-green-300" : ""} ${!showWorkReport ? "col-span-2" : ""}`}
                      variant="outline"
                      onClick={() => setLocation("/documents")}
                    >
                      <FileText className="w-4 h-4" />
                      My Documents
                    </Button>
                  )}
                </div>
              )}

              {showWorkCredit && (
                <Button
                  className="w-full h-12 text-sm gap-1.5 bg-purple-600 hover:bg-purple-700 text-white"
                  onClick={() => setLocation("/work-credit")}
                >
                  <CreditCard className="w-4 h-4" />
                  Work Credit
                </Button>
              )}

              {showContractorDocs && (
                <Button
                  className="w-full h-12 text-sm gap-1.5 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={() => setLocation("/contractor-documents")}
                >
                  <UserPlus className="w-4 h-4" />
                  Contractor Documents
                </Button>
              )}

              {showMyContractors && (
                <Button
                  className="w-full h-12 text-sm gap-1.5 bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={() => setLocation("/my-contractors")}
                >
                  <UsersRound className="w-4 h-4" />
                  My Contractors
                </Button>
              )}
            </>
          );
        })()}

        {/* Flat Rate Assignment — visible to any user with the allowFlatRate flag on. */}
        {!!(user as any)?.allowFlatRate && (
          <Button
            className="w-full h-12 text-sm gap-1.5 bg-pink-600 hover:bg-pink-700 text-white"
            onClick={() => setLocation("/flat-rate-assignment")}
          >
            <Wallet className="w-4 h-4" />
            Flat Rate Assignment
          </Button>
        )}

        {/* Cash Balances */}
        {user?.role !== "contractor" && cashBalances && Object.keys(cashBalances).length > 0 && (
          <div className="border rounded-lg p-3 space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground mb-2">Cash on Hand</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(cashBalances).map(([prop, balance]) => (
                <div key={prop} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground truncate mr-2">{prop}</span>
                  <span className={`font-medium tabular-nums ${balance < 0 ? "text-destructive" : "text-primary"}`}>
                    ${balance.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Checks on Hand — sum of un-deposited check transactions per property */}
        {user?.role !== "contractor" && checkBalances && Object.values(checkBalances).some(v => v > 0) && (
          <div className="border rounded-lg p-3 space-y-1.5 bg-emerald-50/40 dark:bg-emerald-950/10 border-emerald-200/60 dark:border-emerald-800/40">
            <h3 className="text-xs font-medium text-emerald-800 dark:text-emerald-300 mb-2">Checks on Hand</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {Object.entries(checkBalances)
                .filter(([, balance]) => balance > 0)
                .map(([prop, balance]) => (
                  <div key={prop} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground truncate mr-2">{prop}</span>
                    <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                      ${balance.toFixed(2)}
                    </span>
                  </div>
              ))}
            </div>
          </div>
        )}

        {/* Workforce Report (pay calculator).
            - Contractors: locked to themselves
            - Managers: dropdown of themselves + contractors/managers they can see (server-filtered)
            - Admins: use the Admin Panel version which already has this widget */}
        {user && user.role !== "admin" && user.role !== "super_admin" && (
          <WorkforceReport
            lockedUserId={user.role === "contractor" ? user.id : undefined}
            title="Pay Calculator"
          />
        )}

        {user?.role !== "contractor" && (<>
        {/* Filter by user */}
        {showUserFilter && (
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <Select value={userFilter} onValueChange={setUserFilter}>
              <SelectTrigger className="h-9 text-sm" data-testid="select-user-filter">
                <SelectValue placeholder="Filter by user" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All users</SelectItem>
                {filterOptions.map(opt => (
                  <SelectItem key={opt.id} value={String(opt.id)}>
                    {opt.name}{opt.id === user?.id ? " (me)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {userFilter !== "all" && (
              <Button variant="ghost" size="sm" onClick={() => setUserFilter("all")} className="h-9 px-2 text-xs">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}

        {/* Filter by property — admin/super_admin only (item 8) */}
        {showPropertyFilter && (
          <div className="flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <Select value={propertyFilter} onValueChange={setPropertyFilter}>
              <SelectTrigger className="h-9 text-sm" data-testid="select-property-filter">
                <SelectValue placeholder="Filter by property" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All properties</SelectItem>
                {propertyFilterOptions.map(p => (
                  <SelectItem key={p} value={p}>{p}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {propertyFilter !== "all" && (
              <Button variant="ghost" size="sm" onClick={() => setPropertyFilter("all")} className="h-9 px-2 text-xs">
                <X className="w-3.5 h-3.5" />
              </Button>
            )}
          </div>
        )}

        {/* Section header */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setShowReceipts(s => !s)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            data-testid="toggle-receipts"
            aria-expanded={showReceipts}
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${showReceipts ? "" : "-rotate-90"}`} />
            <span>Recent Receipts</span>
            {filteredInvoices && filteredInvoices.length > 0 && (
              <span className="text-xs text-muted-foreground/80 font-normal">({filteredInvoices.length})</span>
            )}
          </button>
          {(user?.role === "admin" || user?.role === "super_admin") && invoices && invoices.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleExport} className="text-xs gap-1" data-testid="button-export">
              <Download className="w-3.5 h-3.5" />
              Export CSV
            </Button>
          )}
        </div>

        {/* Invoice list — collapsible */}
        {showReceipts && (isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <Card key={i}>
                <CardContent className="py-3 flex gap-3">
                  <Skeleton className="w-12 h-12 rounded-lg flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredInvoices && filteredInvoices.length > 0 ? (
          <div className="space-y-2">
            {filteredInvoices.map(inv => (
              <Card key={inv.id} data-testid={`card-invoice-${inv.id}`}>
                <CardContent className="py-3 flex gap-3">
                  <PhotoThumb
                    paths={(inv as any).photoPaths || [inv.photoPath]}
                    onClick={() => setViewingPhotos((inv as any).photoPaths || [inv.photoPath])}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p
                        className="text-sm font-medium truncate cursor-pointer"
                        title="Tap to view full details"
                        onClick={() => setDetailsModal({
                          title: inv.description || "Receipt",
                          lines: [
                            { label: "Description", value: inv.description || "" },
                            { label: "Purpose / Use", value: inv.purpose || "" },
                            { label: "Amount", value: `$${inv.amount}` },
                            { label: "Property", value: (inv as any).property || "" },
                            { label: "Date", value: (inv as any).purchaseDate || "" },
                            { label: "Bought by", value: inv.boughtBy || "" },
                            { label: "Payment", value: inv.paymentMethod === "cash" ? "Cash" : `Card ••${inv.lastFourDigits || ""}` },
                            { label: "Receipt ID", value: (inv as any).recordNumber || "" },
                            { label: "Submitted by", value: (inv as any).submittedBy || "" },
                          ].filter(l => l.value),
                        })}
                      >
                        {inv.description}
                      </p>
                      <div className="flex items-center gap-1">
                        <span className="text-sm font-semibold whitespace-nowrap">${inv.amount}</span>
                        <button
                          className="text-muted-foreground hover:text-primary p-0.5"
                          onClick={() => {
                            if (window.confirm("You are about to edit this item. Are you sure?")) {
                              setEditDescription(inv.description);
                              setEditPurpose(inv.purpose);
                              setEditAmount(inv.amount);
                              setEditBoughtBy(inv.boughtBy);
                              setEditPaymentMethod(inv.paymentMethod as "cash" | "cc");
                              setEditLastFour(inv.lastFourDigits || "");
                              setEditRmIssue((inv as any).rentManagerIssue || "");
                              setEditingInvoice(inv);
                            }
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          className="text-muted-foreground hover:text-destructive p-0.5"
                          onClick={() => {
                            if (window.confirm("Delete this receipt?")) {
                              deleteInvoiceMutation.mutate(inv.id);
                            }
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p
                      className="text-xs text-muted-foreground truncate cursor-pointer"
                      onClick={() => setDetailsModal({
                        title: inv.description || "Receipt",
                        lines: [
                          { label: "Description", value: inv.description || "" },
                          { label: "Purpose / Use", value: inv.purpose || "" },
                          { label: "Amount", value: `$${inv.amount}` },
                          { label: "Property", value: (inv as any).property || "" },
                          { label: "Date", value: (inv as any).purchaseDate || "" },
                          { label: "Bought by", value: inv.boughtBy || "" },
                          { label: "Payment", value: inv.paymentMethod === "cash" ? "Cash" : `Card ••${inv.lastFourDigits || ""}` },
                          { label: "Receipt ID", value: (inv as any).recordNumber || "" },
                          { label: "Submitted by", value: (inv as any).submittedBy || "" },
                        ].filter(l => l.value),
                      })}
                    >
                      {inv.purpose}
                    </p>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {inv.recordNumber && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                          #{inv.recordNumber}
                        </Badge>
                      )}
                      {inv.property && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                          <Building2 className="w-2.5 h-2.5" />
                          {inv.property}
                        </Badge>
                      )}
                      <span className="text-xs text-muted-foreground">{inv.purchaseDate}</span>
                      <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                        {inv.paymentMethod === "cc" ? (
                          <>
                            <CreditCard className="w-2.5 h-2.5" />
                            {inv.lastFourDigits ? `••${inv.lastFourDigits}` : "Card"}
                          </>
                        ) : (
                          <>
                            <Banknote className="w-2.5 h-2.5" />
                            Cash
                          </>
                        )}
                      </Badge>
                      {inv.rentManagerIssue && (
                        <span className="text-xs text-muted-foreground">RM #{inv.rentManagerIssue}</span>
                      )}
                      {inv.boughtBy !== inv.submittedBy && (
                        <span className="text-xs text-muted-foreground">buyer: {inv.boughtBy}</span>
                      )}
                      {(user?.role === "admin" || user?.role === "super_admin") && (
                        <span className="text-xs text-muted-foreground">
                          {inv.boughtBy !== inv.submittedBy ? `· ${inv.submittedBy}` : `by ${inv.submittedBy}`}
                        </span>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <div className="text-center py-12">
            <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center mx-auto mb-3">
              <FileText className="w-7 h-7 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">No receipts yet</p>
            <p className="text-xs text-muted-foreground mt-1">Tap "New Receipt" to submit your first one.</p>
          </div>
        ))}

        {/* ---- CASH TRANSACTIONS SECTION (collapsible) ---- */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowCashTxs(s => !s)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid="toggle-cash-txs"
              aria-expanded={showCashTxs}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showCashTxs ? "" : "-rotate-90"}`} />
              <span>Cash Transactions</span>
              {filteredCashTxs && filteredCashTxs.length > 0 && (
                <span className="text-xs text-muted-foreground/80 font-normal">({filteredCashTxs.length})</span>
              )}
            </button>
            {(user?.role === "admin" || user?.role === "super_admin") && cashTxs && cashTxs.length > 0 && (
              <Button variant="ghost" size="sm" onClick={handleCashExport} className="text-xs gap-1">
                <Download className="w-3.5 h-3.5" /> Export CSV
              </Button>
            )}
          </div>
          {showCashTxs && (filteredCashTxs && filteredCashTxs.length > 0 ? (
            <div className="space-y-2">
              {filteredCashTxs.map((tx: any) => {
                // Whole-card tap opens the details modal (mirrors the CC card
                // detail view). Inner controls (photo thumb, pencil, trash,
                // description link) call stopPropagation to keep their own
                // behavior.
                const openDetails = () => setDetailsModal({
                  title: tx.description || (tx.category ? formatCashCategory(tx.category) : "Cash transaction"),
                  lines: [
                    { label: "Description", value: tx.description || "" },
                    { label: "Amount", value: `$${tx.amount}` },
                    { label: "Type", value: tx.type === "income" ? "Income" : "Spent" },
                    { label: "Category", value: formatCashCategory(tx.category) },
                    { label: "Property", value: tx.property || "" },
                    { label: "Date", value: tx.date || "" },
                    { label: "Unit / Lot", value: tx.unitLotNumber || "" },
                    { label: "Tenant / From", value: tx.tenantName || tx.payerName || "" },
                    { label: "Bank", value: tx.bankName || "" },
                    { label: "Notes", value: tx.notes || "" },
                    { label: "Record ID", value: tx.propertyCode || (tx.recordNumber != null ? `#${tx.recordNumber}` : "") },
                    { label: "Submitted by", value: tx.submittedBy || "" },
                  ].filter(l => l.value),
                });
                return (
                <Card
                  key={tx.id}
                  onClick={openDetails}
                  className="cursor-pointer hover:bg-accent/40 transition-colors"
                  data-testid={`cash-card-${tx.id}`}
                >
                  <CardContent className="py-3 flex gap-3">
                    {/* Photo thumbnail (image, PDF, or other) */}
                    {tx.photoPath && (
                      <PhotoThumb
                        paths={tx.photoPaths || [tx.photoPath]}
                        onClick={(e?: any) => { e?.stopPropagation?.(); setViewingPhotos(tx.photoPaths || [tx.photoPath]); }}
                      />
                    )}
                    <div className="flex items-start justify-between gap-2 flex-1">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${tx.type === "income" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                            {tx.type === "income" ? "Income" : "Spent"}
                          </span>
                          <span className="text-xs text-muted-foreground">{formatCashCategory(tx.category)}</span>
                        </div>
                        <p className="text-sm font-medium mt-1">${tx.amount}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                            <Building2 className="w-2.5 h-2.5" />
                            {tx.property}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{tx.date}</span>
                          {tx.description && (
                            <span
                              className="text-xs text-muted-foreground truncate max-w-[120px]"
                              title="Tap card to view full details"
                            >
                              {tx.description}
                            </span>
                          )}
                          {tx.recordNumber && (
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                              #{tx.recordNumber}
                            </Badge>
                          )}
                          {(user?.role === "admin" || user?.role === "super_admin") && tx.submittedBy && (
                            <span className="text-xs text-muted-foreground">by {tx.submittedBy}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button className="text-muted-foreground hover:text-primary p-0.5" onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm("You are about to edit this item. Are you sure?")) {
                            setEditingCashTx(tx);
                            setEditCashAmount(tx.amount);
                            setEditCashCategory(tx.category);
                            setEditCashDescription(tx.description || "");
                            setEditCashUnitLot(tx.unitLotNumber || "");
                            setEditCashTenantName(tx.tenantName || "");
                            setEditCashBankName(tx.bankName || "");
                          }
                        }}>
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button className="text-muted-foreground hover:text-destructive p-0.5" onClick={(e) => { e.stopPropagation(); handleCashDelete(tx.id); }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No cash transactions yet.</p>
          ))}
        </div>
        </>)}

        {/* ---- CHECK TRANSACTIONS SECTION (collapsible) ---- */}
        {user?.role !== "contractor" && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowCheckTxs(s => !s)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              aria-expanded={showCheckTxs}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showCheckTxs ? "" : "-rotate-90"}`} />
              <span>Check Transactions</span>
              {filteredCheckTxs && filteredCheckTxs.length > 0 && (
                <span className="text-xs text-muted-foreground/80 font-normal">({filteredCheckTxs.length})</span>
              )}
            </button>
          </div>
          {showCheckTxs && (filteredCheckTxs && filteredCheckTxs.length > 0 ? (
            <div className="space-y-2">
              {filteredCheckTxs.map((tx: any) => (
                <Card key={tx.id}>
                  <CardContent className="py-3 flex gap-3">
                    <PhotoThumb
                      paths={(tx as any).photoPaths ? JSON.parse((tx as any).photoPaths) : (tx.photoPath ? [tx.photoPath] : [])}
                      onClick={() => {
                        const paths = (tx as any).photoPaths ? JSON.parse((tx as any).photoPaths) : (tx.photoPath ? [tx.photoPath] : []);
                        if (paths.length > 0) setViewingPhotos(paths);
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {tx.payerName || "Check"}
                            {tx.checkNumber ? <span className="text-xs text-muted-foreground"> #{tx.checkNumber}</span> : null}
                          </p>
                          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 gap-1">
                              <Building2 className="w-2.5 h-2.5" />
                              {tx.property}
                            </Badge>
                            <span className="text-xs text-muted-foreground">{tx.date}</span>
                            {tx.recordNumber && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                                #{(tx as any).propertyCode || tx.recordNumber}
                              </Badge>
                            )}
                            {tx.deposited ? (
                              <Badge className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-800 border-emerald-300">
                                Deposited
                              </Badge>
                            ) : (
                              <Badge className="text-[10px] px-1.5 py-0 h-4 bg-amber-100 text-amber-800 border-amber-300">
                                On Hand
                              </Badge>
                            )}
                          </div>
                          {tx.notes && <p className="text-xs text-muted-foreground mt-0.5 truncate">{tx.notes}</p>}
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <span className="text-sm font-semibold whitespace-nowrap text-emerald-700">${tx.amount}</span>
                          {!tx.deposited && (
                            <Button
                              size="sm" variant="outline"
                              className="h-7 text-xs px-2 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                              onClick={() => {
                                setDepositingCheck(tx);
                                setDepositPhotoPath("");
                                setDepositPhotoPreview("");
                              }}
                              data-testid={`button-mark-deposited-${tx.id}`}
                            >
                              Mark Deposited
                            </Button>
                          )}
                          {(user?.role === "admin" || user?.role === "super_admin" || tx.userId === user?.id) && (
                            <button
                              className="text-muted-foreground hover:text-destructive p-0.5"
                              onClick={async () => {
                                if (!confirm("Delete this check transaction?")) return;
                                try {
                                  await apiRequest("DELETE", `/api/check-transactions/${tx.id}`);
                                  queryClient.invalidateQueries({ queryKey: ["/api/check-transactions"] });
                                  queryClient.invalidateQueries({ queryKey: ["/api/check-transactions/balances"] });
                                  toast({ title: "Check deleted" });
                                } catch (e: any) {
                                  toast({ title: "Failed", description: e.message, variant: "destructive" });
                                }
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No check transactions yet.</p>
          ))}
        </div>
        )}

        {/* ---- TIME REPORTS SECTION (collapsible) ---- */}
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => setShowWorkReports(s => !s)}
            className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            data-testid="toggle-work-reports"
            aria-expanded={showWorkReports}
          >
            <ChevronDown className={`w-4 h-4 transition-transform ${showWorkReports ? "" : "-rotate-90"}`} />
            <span>Work Reports</span>
            {filteredTimeReports && filteredTimeReports.length > 0 && (
              <span className="text-xs text-muted-foreground/80 font-normal">({filteredTimeReports.length})</span>
            )}
          </button>
          {showWorkReports && (filteredTimeReports && filteredTimeReports.length > 0 ? (
            <div className="space-y-2">
              {filteredTimeReports.map((tr: any) => (
                <Card key={tr.id}>
                  <CardContent className="py-3 flex gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center flex-shrink-0">
                      <Clock className="w-5 h-5 text-blue-600" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium">{tr.property} — {tr.date}</p>
                          <p className="text-xs text-muted-foreground">
                            {(() => {
                              try {
                                const blocks = tr.timeBlocks ? JSON.parse(tr.timeBlocks) : [];
                                if (blocks.length > 1) return blocks.map((b: any) => `${b.start}–${b.end}`).join(", ");
                              } catch {}
                              return `${tr.startTime} – ${tr.endTime}`;
                            })()}
                          </p>
                        </div>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <button
                            className="text-muted-foreground hover:text-blue-600 p-0.5"
                            title="Download report"
                            onClick={() => {
                              // Build a text summary for download
                              let blocks: any[] = [];
                              try { blocks = tr.timeBlocks ? JSON.parse(tr.timeBlocks) : []; } catch {}
                              const timeStr = blocks.length > 0
                                ? blocks.map((b: any) => `${b.start} - ${b.end}`).join(", ")
                                : `${tr.startTime} - ${tr.endTime}`;
                              let accs: string[] = [];
                              try { accs = JSON.parse(tr.accomplishments); } catch {}
                              const lines = [
                                `Work Report - ${tr.date}`,
                                `Employee: ${tr.submittedBy || user?.displayName || "N/A"}`,
                                `Property: ${tr.property}`,
                                `Time: ${timeStr}`,
                                ``,
                                `Accomplishments:`,
                                ...accs.map(a => `  - ${a}`),
                              ];
                              if (tr.miles && parseFloat(tr.miles) > 0) lines.push(`Miles: ${tr.miles} ($${tr.mileageAmount})`);
                              if (tr.specialTerms === 1 && tr.specialTermsAmount) lines.push(`Special Terms: $${tr.specialTermsAmount}`);
                              if (tr.notes) lines.push(`Notes: ${tr.notes}`);
                              const blob = new Blob([lines.join("\n")], { type: "text/plain" });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement("a");
                              a.href = url;
                              a.download = `Work_Report_${tr.date}_${tr.property.replace(/\s/g, "_")}.txt`;
                              a.click();
                              URL.revokeObjectURL(url);
                            }}
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          <button
                            className="text-muted-foreground hover:text-destructive p-0.5"
                            onClick={async () => {
                              if (!window.confirm("Delete this work report?")) return;
                              try {
                                await apiRequest("DELETE", `/api/time-reports/${tr.id}`);
                                queryClient.invalidateQueries({ queryKey: ["/api/time-reports"] });
                                toast({ title: "Report deleted" });
                              } catch {
                                toast({ title: "Failed to delete", variant: "destructive" });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1">
                        {(() => {
                          try {
                            const items = JSON.parse(tr.accomplishments);
                            return items.map((item: string, i: number) => (
                              <p key={i} className="text-xs text-muted-foreground">• {item}</p>
                            ));
                          } catch { return <p className="text-xs text-muted-foreground">{tr.accomplishments}</p>; }
                        })()}
                      </div>
                      {tr.miles && parseFloat(tr.miles) > 0 && (
                        <p className="text-xs text-blue-600 mt-1">{tr.miles} mi — ${tr.mileageAmount}</p>
                      )}
                      {tr.specialTerms === 1 && tr.specialTermsAmount && (
                        <p className="text-xs text-purple-600">Special: ${tr.specialTermsAmount}</p>
                      )}
                      {(user?.role === "admin" || user?.role === "super_admin") && tr.submittedBy && (
                        <span className="text-xs text-muted-foreground">by {tr.submittedBy}</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No work reports yet.</p>
          ))}
        </div>

        {/* ---- FLAT RATE ASSIGNMENTS SECTION (collapsible) ---- */}
        {filteredFlatRates && filteredFlatRates.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowFlatRates(s => !s)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid="toggle-flat-rates"
              aria-expanded={showFlatRates}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showFlatRates ? "" : "-rotate-90"}`} />
              <span>Flat Rate Assignments</span>
              <span className="text-xs text-muted-foreground/80 font-normal">({filteredFlatRates.length})</span>
            </button>
            {showFlatRates && (
            <div className="space-y-2">
              {filteredFlatRates.map((fr: any) => {
                let accs: string[] = [];
                try { accs = JSON.parse(fr.accomplishments || "[]"); } catch {}
                const rateNum = parseFloat(fr.rate || "0");
                return (
                  <Card key={fr.id}>
                    <CardContent className="py-3 flex gap-3">
                      <div className="w-10 h-10 rounded-lg bg-pink-50 flex items-center justify-center flex-shrink-0">
                        <Wallet className="w-5 h-5 text-pink-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">
                              <span className="text-pink-700">${rateNum.toFixed(2)}</span> · {fr.property} — {fr.date}
                            </p>
                            {fr.submittedBy && (
                              <p className="text-xs text-muted-foreground">by {fr.submittedBy}</p>
                            )}
                          </div>
                          <button
                            className="text-muted-foreground hover:text-destructive p-0.5"
                            onClick={async () => {
                              if (!window.confirm("Delete this flat-rate entry?")) return;
                              try {
                                await apiRequest("DELETE", `/api/flat-rate-assignments/${fr.id}`);
                                queryClient.invalidateQueries({ queryKey: ["/api/flat-rate-assignments"] });
                                toast({ title: "Entry deleted" });
                              } catch {
                                toast({ title: "Failed to delete", variant: "destructive" });
                              }
                            }}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {accs.length > 0 && (
                          <div className="mt-1">
                            {accs.map((a, i) => (
                              <p key={i} className="text-xs text-muted-foreground">• {a}</p>
                            ))}
                          </div>
                        )}
                        {fr.notes && (
                          <p className="text-xs text-muted-foreground italic mt-1">{fr.notes}</p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            )}
          </div>
        )}

        {/* ---- WORK CREDITS SECTION (collapsible) ---- */}
        {filteredWorkCredits && filteredWorkCredits.length > 0 && (
          <div className="space-y-2">
            <button
              type="button"
              onClick={() => setShowWorkCredits(s => !s)}
              className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              data-testid="toggle-work-credits"
              aria-expanded={showWorkCredits}
            >
              <ChevronDown className={`w-4 h-4 transition-transform ${showWorkCredits ? "" : "-rotate-90"}`} />
              <span>Work Credits</span>
              <span className="text-xs text-muted-foreground/80 font-normal">({filteredWorkCredits.length})</span>
            </button>
            {showWorkCredits && (
            <div className="space-y-2">
              {filteredWorkCredits.map((wc: any) => {
                let descList: string[] = [];
                try { descList = JSON.parse(wc.workDescriptions); } catch {}
                return (
                  <Card key={wc.id}>
                    <CardContent className="py-3 flex gap-3">
                      <div className="w-10 h-10 rounded-lg bg-purple-50 flex items-center justify-center flex-shrink-0">
                        <CreditCard className="w-5 h-5 text-purple-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-medium">{wc.tenantFirstName} {wc.tenantLastName} — {wc.property}</p>
                            <p className="text-xs text-muted-foreground">
                              {wc.date} · Lot/Unit: {wc.lotOrUnit} · {wc.creditType === "fixed" ? "Fixed" : `${wc.hoursWorked}h × $${wc.hourlyRate}`}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <span className="text-sm font-semibold text-purple-600">${wc.totalAmount}</span>
                            <button
                              className="text-muted-foreground hover:text-destructive p-0.5"
                              onClick={async () => {
                                if (!window.confirm("Delete this work credit?")) return;
                                try {
                                  await apiRequest("DELETE", `/api/work-credits/${wc.id}`);
                                  queryClient.invalidateQueries({ queryKey: ["/api/work-credits"] });
                                  toast({ title: "Work credit deleted" });
                                } catch {
                                  toast({ title: "Failed to delete", variant: "destructive" });
                                }
                              }}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        {descList.length > 0 && (
                          <div className="mt-1">
                            {descList.map((item: string, i: number) => (
                              <p key={i} className="text-xs text-muted-foreground">• {item}</p>
                            ))}
                          </div>
                        )}
                        {(user?.role === "admin" || user?.role === "super_admin") && wc.submittedBy && (
                          <span className="text-xs text-muted-foreground">by {wc.submittedBy}</span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="text-center py-6">
        <a
          href="https://www.perplexity.ai/computer"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Created with Perplexity Computer
        </a>
      </div>

      <Dialog open={editingInvoice !== null} onOpenChange={(open) => { if (!open) setEditingInvoice(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Receipt</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">What Was Bought</Label>
              <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">What For / Use</Label>
              <Input value={editPurpose} onChange={e => setEditPurpose(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Amount ($)</Label>
              <Input type="number" step="0.01" value={editAmount} onChange={e => setEditAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Bought By</Label>
              <Input value={editBoughtBy} onChange={e => setEditBoughtBy(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Rent Manager Issue #</Label>
              <Input value={editRmIssue} onChange={e => setEditRmIssue(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setEditingInvoice(null)}>Cancel</Button>
            <Button className="flex-1" disabled={editSaving} onClick={async () => {
              setEditSaving(true);
              try {
                await apiRequest("PUT", `/api/invoices/${editingInvoice!.id}`, {
                  description: editDescription,
                  purpose: editPurpose,
                  amount: editAmount,
                  boughtBy: editBoughtBy,
                  rentManagerIssue: editRmIssue || undefined,
                });
                queryClient.invalidateQueries({ queryKey: ["/api/invoices"] });
                setEditingInvoice(null);
                toast({ title: "Receipt updated" });
              } catch (err: any) {
                toast({ title: "Failed to update", description: "Please try again.", variant: "destructive" });
              } finally {
                setEditSaving(false);
              }
            }}>
              {editSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mark-as-Deposited dialog — a simple confirmation, no slip upload. */}
      <Dialog
        open={depositingCheck !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDepositingCheck(null);
            setDepositPhotoPath("");
            setDepositPhotoPreview("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark Check as Deposited</DialogTitle>
            <DialogDescription>
              Confirm this is the check you've deposited. It will be removed from Checks on Hand.
            </DialogDescription>
          </DialogHeader>
          {depositingCheck && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
              <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                <span className="text-muted-foreground">Amount</span>
                <span className="font-semibold text-right">${depositingCheck.amount}</span>
                <span className="text-muted-foreground">From</span>
                <span className="text-right">{depositingCheck.payerName || "—"}</span>
                <span className="text-muted-foreground">Property</span>
                <span className="text-right">{depositingCheck.property}</span>
                {depositingCheck.checkNumber && (<>
                  <span className="text-muted-foreground">Check #</span>
                  <span className="text-right">{depositingCheck.checkNumber}</span>
                </>)}
              </div>
            </div>
          )}
          <div className="flex gap-2 justify-end mt-3">
            <Button
              variant="outline"
              onClick={() => setDepositingCheck(null)}
              disabled={depositSaving}
            >
              Cancel
            </Button>
            <Button
              disabled={depositSaving}
              onClick={async () => {
                if (!depositingCheck) return;
                setDepositSaving(true);
                try {
                  await apiRequest("POST", `/api/check-transactions/${depositingCheck.id}/deposit`, {});
                  queryClient.invalidateQueries({ queryKey: ["/api/check-transactions"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/check-transactions/balances"] });
                  toast({ title: "Marked as deposited" });
                  setDepositingCheck(null);
                } catch (e: any) {
                  toast({ title: "Failed", description: e.message, variant: "destructive" });
                } finally { setDepositSaving(false); }
              }}
            >
              {depositSaving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              Confirm Deposit
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Full-details modal triggered by tapping a truncated description (item 7). */}
      <Dialog open={detailsModal !== null} onOpenChange={(open) => { if (!open) setDetailsModal(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="break-words">{detailsModal?.title}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {detailsModal?.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[110px_1fr] gap-2">
                <span className="text-xs uppercase tracking-wide text-muted-foreground pt-0.5">{l.label}</span>
                <span className="break-words whitespace-pre-wrap">{l.value}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end mt-3">
            <Button variant="outline" onClick={() => setDetailsModal(null)}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={editingCashTx !== null} onOpenChange={(open) => { if (!open) setEditingCashTx(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit Cash Transaction</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Amount ($)</Label>
              <Input type="number" step="0.01" value={editCashAmount} onChange={e => setEditCashAmount(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Category</Label>
              <Select value={editCashCategory} onValueChange={setEditCashCategory}>
                <SelectTrigger data-testid="select-cash-category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {/* Show categories matching the current transaction's direction. */}
                  {(editingCashTx && ["rental_income","check","washer","dryer","vending","store_items","eod_cash_on_hand"].includes(editingCashTx.category)) ? (
                    <>
                      <SelectItem value="rental_income">Rental Income</SelectItem>
                      <SelectItem value="check">Check</SelectItem>
                      <SelectItem value="washer">Washer</SelectItem>
                      <SelectItem value="dryer">Dryer</SelectItem>
                      <SelectItem value="vending">Vending</SelectItem>
                      <SelectItem value="store_items">Store Items</SelectItem>
                      <SelectItem value="eod_cash_on_hand">End of Day - Cash on Hand</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </>
                  ) : (
                    <>
                      <SelectItem value="bank_deposit">Bank Deposit</SelectItem>
                      <SelectItem value="item_purchased">Item Purchased</SelectItem>
                      <SelectItem value="contractor_pay">Contractor Pay</SelectItem>
                      <SelectItem value="other">Other</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Description</Label>
              <Input value={editCashDescription} onChange={e => setEditCashDescription(e.target.value)} />
            </div>
            {editingCashTx?.category === "bank_deposit" && (
              <div className="space-y-1">
                <Label className="text-xs">Bank Name</Label>
                <Input value={editCashBankName} onChange={e => setEditCashBankName(e.target.value)} />
              </div>
            )}
            {editingCashTx?.category === "rental_income" && (
              <>
                <div className="space-y-1">
                  <Label className="text-xs">Unit/Lot</Label>
                  <Input value={editCashUnitLot} onChange={e => setEditCashUnitLot(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Tenant Name</Label>
                  <Input value={editCashTenantName} onChange={e => setEditCashTenantName(e.target.value)} />
                </div>
              </>
            )}
          </div>
          <div className="flex gap-2 mt-4">
            <Button variant="outline" className="flex-1" onClick={() => setEditingCashTx(null)}>Cancel</Button>
            <Button className="flex-1" disabled={editCashSaving} onClick={async () => {
              setEditCashSaving(true);
              try {
                await apiRequest("PUT", `/api/cash-transactions/${editingCashTx!.id}`, {
                  amount: editCashAmount,
                  category: editCashCategory || undefined,
                  description: editCashDescription,
                  bankName: editCashBankName || undefined,
                  unitLotNumber: editCashUnitLot || undefined,
                  tenantName: editCashTenantName || undefined,
                });
                queryClient.invalidateQueries({ queryKey: ["/api/cash-transactions"] });
                queryClient.invalidateQueries({ queryKey: ["/api/cash-balances"] });
                setEditingCashTx(null);
                toast({ title: "Transaction updated" });
              } catch {
                toast({ title: "Failed to update", variant: "destructive" });
              } finally {
                setEditCashSaving(false);
              }
            }}>
              {editCashSaving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {viewingPhotos && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => { setViewingPhotos(null); setViewPhotoIdx(0); setPhotoZoom(1); }}
        >
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            {(() => {
              const cur = viewingPhotos[viewPhotoIdx];
              if (isPdfPath(cur)) {
                return (
                  <div className="bg-white rounded-lg overflow-hidden" style={{ height: "80vh" }}>
                    <embed
                      src={authImgUrl(cur)}
                      type="application/pdf"
                      className="w-full h-full"
                    />
                    <div className="absolute bottom-12 left-1/2 -translate-x-1/2">
                      <a
                        href={authImgUrl(cur)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bg-white text-black text-xs px-3 py-1.5 rounded-full font-medium shadow"
                      >
                        Open PDF in new tab
                      </a>
                    </div>
                  </div>
                );
              }
              if (!isImagePath(cur)) {
                return (
                  <div className="bg-white rounded-lg p-8 flex flex-col items-center gap-3">
                    <FileText className="w-12 h-12 text-muted-foreground" />
                    <p className="text-sm text-center">This receipt is a file, not an image.</p>
                    <a
                      href={authImgUrl(cur)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="bg-primary text-primary-foreground text-sm px-4 py-2 rounded-md font-medium"
                    >
                      Open in new tab
                    </a>
                  </div>
                );
              }
              return (
                <ZoomablePhoto
                  src={authImgUrl(cur)}
                  zoom={photoZoom}
                  onZoomChange={setPhotoZoom}
                />
              );
            })()}
            {viewingPhotos.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                {viewPhotoIdx + 1} / {viewingPhotos.length}
              </div>
            )}
            {viewingPhotos.length > 1 && viewPhotoIdx > 0 && (
              <button className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => { setViewPhotoIdx(i => i - 1); setPhotoZoom(1); }}>
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {viewingPhotos.length > 1 && viewPhotoIdx < viewingPhotos.length - 1 && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => { setViewPhotoIdx(i => i + 1); setPhotoZoom(1); }}>
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
            <button
              className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center"
              onClick={() => { setViewingPhotos(null); setViewPhotoIdx(0); }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
      </div>
    </LogoBackground>
  );
}

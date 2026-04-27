import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Clock, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface WorkforceUser {
  id: number;
  displayName: string;
  role?: string;
  firstName?: string | null;
  lastName?: string | null;
}

interface Props {
  /**
   * Users selectable in the dropdown. Pass users already filtered by the
   * caller's permission. If omitted, the component fetches from
   * /api/workforce-report/available-users.
   */
  users?: WorkforceUser[];
  /**
   * Which endpoint to hit. Defaults to the non-admin route.
   */
  endpoint?: string;
  /**
   * If true, the user dropdown is hidden and the report is locked to
   * `lockedUserId` (for contractors who can only see their own data).
   */
  lockedUserId?: number;
  /**
   * Optional title override. Defaults to "Workforce Report".
   */
  title?: string;
  /**
   * Optional class for the outer section.
   */
  className?: string;
}

export function WorkforceReport({
  users: usersProp,
  endpoint = "/api/workforce-report",
  lockedUserId,
  title = "Workforce Report",
  className = "",
}: Props) {
  const { toast } = useToast();

  // Auto-fetch users if not provided
  const { data: fetchedUsers } = useQuery<WorkforceUser[]>({
    queryKey: ["/api/workforce-report/available-users"],
    enabled: !usersProp && !lockedUserId,
  });
  const users = usersProp ?? fetchedUsers;

  const [wfUserId, setWfUserId] = useState<string>(lockedUserId ? String(lockedUserId) : "");
  const [wfStartDate, setWfStartDate] = useState<string>("");
  const [wfEndDate, setWfEndDate] = useState<string>("");
  const [wfLoading, setWfLoading] = useState(false);
  const [wfResult, setWfResult] = useState<any>(null);

  useEffect(() => {
    if (lockedUserId) setWfUserId(String(lockedUserId));
  }, [lockedUserId]);

  async function runReport() {
    if (!wfUserId || !wfStartDate || !wfEndDate) return;
    setWfLoading(true);
    setWfResult(null);
    try {
      const res = await apiRequest(
        "GET",
        `${endpoint}?userId=${wfUserId}&startDate=${wfStartDate}&endDate=${wfEndDate}`
      );
      const data = await res.json();
      setWfResult(data);
    } catch (e: any) {
      toast({ title: "Failed to generate report", description: e.message, variant: "destructive" });
    } finally {
      setWfLoading(false);
    }
  }

  const disabled = wfLoading || !wfUserId || !wfStartDate || !wfEndDate;

  return (
    <section className={`space-y-3 border rounded-lg p-3 ${className}`}>
      <h2 className="text-base font-semibold flex items-center gap-2">
        <Clock className="w-4 h-4 text-blue-600" />
        {title}
      </h2>
      <div className="space-y-2">
        {!lockedUserId && (
          <div className="space-y-1">
            <Label className="text-xs">Employee</Label>
            <Select value={wfUserId} onValueChange={setWfUserId}>
              <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
              <SelectContent>
                {users?.map(u => (
                  <SelectItem key={u.id} value={String(u.id)}>{u.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs">Start Date</Label>
            <Input type="date" value={wfStartDate} onChange={e => setWfStartDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">End Date</Label>
            <Input type="date" value={wfEndDate} onChange={e => setWfEndDate(e.target.value)} />
          </div>
        </div>
        <Button size="sm" className="w-full" disabled={disabled} onClick={runReport}>
          {wfLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
          Generate Report
        </Button>
      </div>

      {wfResult && (
        <div className="border rounded-md p-3 space-y-3 bg-muted/30">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">
              {wfResult.user.firstName && wfResult.user.lastName
                ? `${wfResult.user.firstName} ${wfResult.user.lastName}`
                : wfResult.user.displayName}
            </p>
            <span className="text-xs text-muted-foreground">
              {wfResult.period.startDate} to {wfResult.period.endDate}
            </span>
          </div>

          {/* Financial Summary */}
          <div className="bg-blue-50 dark:bg-blue-950/30 rounded-md p-3 space-y-1">
            <p className="text-xs font-semibold text-blue-800 dark:text-blue-300 mb-2">Pay Summary</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div className="text-muted-foreground">Days Worked</div>
              <div className="text-right font-medium">{wfResult.summary.daysWorked}</div>
              <div className="text-muted-foreground">Total Hours</div>
              <div className="text-right font-medium">{wfResult.summary.totalHours} hrs</div>
              <div className="text-muted-foreground">Rate</div>
              <div className="text-right font-medium">${wfResult.summary.baseRate}/hr</div>
              <div className="text-muted-foreground">Labor ({wfResult.summary.totalHours}h × ${wfResult.summary.baseRate})</div>
              <div className="text-right font-semibold">${wfResult.summary.laborCost?.toFixed(2)}</div>
              <div className="text-muted-foreground">Mileage ({wfResult.summary.totalMiles} mi)</div>
              <div className="text-right">${wfResult.summary.totalMileagePay?.toFixed(2)}</div>
              <div className="text-muted-foreground">Special Terms / Travel</div>
              <div className="text-right">${wfResult.summary.totalSpecialTerms?.toFixed(2)}</div>
              {wfResult.summary.flatRateCount > 0 && (
                <>
                  <div className="text-muted-foreground">Flat Rate ({wfResult.summary.flatRateCount} {wfResult.summary.flatRateCount === 1 ? "entry" : "entries"})</div>
                  <div className="text-right">${wfResult.summary.totalFlatRate?.toFixed(2)}</div>
                </>
              )}
            </div>
            <div className="border-t border-blue-200 dark:border-blue-800 mt-2 pt-2 flex justify-between items-center">
              <span className="font-bold text-sm">Total Pay</span>
              <span className="font-bold text-lg text-blue-700 dark:text-blue-300">${wfResult.summary.grandTotal?.toFixed(2)}</span>
            </div>
          </div>

          {/* Flat-rate entries */}
          {wfResult.flatRates && wfResult.flatRates.length > 0 && (
            <div className="space-y-1 mt-2">
              <p className="text-xs font-medium text-muted-foreground">Flat-Rate Entries ({wfResult.flatRates.length})</p>
              {wfResult.flatRates.map((fr: any) => (
                <details key={fr.id} className="text-xs bg-background rounded border">
                  <summary className="p-2 cursor-pointer hover:bg-muted/50 flex justify-between items-center">
                    <span><span className="font-medium">{fr.date}</span> — {fr.property}</span>
                    <span className="font-semibold text-pink-700 dark:text-pink-400">${fr.rate.toFixed(2)}</span>
                  </summary>
                  <div className="p-2 pt-0 border-t space-y-1">
                    {fr.accomplishmentsList?.length > 0 && (
                      <div>
                        <span className="text-muted-foreground">Accomplishments:</span>
                        <ul className="list-disc list-inside ml-1">
                          {fr.accomplishmentsList.map((a: string, i: number) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {fr.notes && <p className="text-muted-foreground">Notes: {fr.notes}</p>}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* Collapsible Entries */}
          {wfResult.reports.length > 0 && (
            <div className="space-y-1 mt-2">
              <p className="text-xs font-medium text-muted-foreground">Entries ({wfResult.reports.length} reports) — tap to expand</p>
              {wfResult.reports.map((r: any) => {
                const timeDisplay = (() => {
                  try {
                    const blocks = r.timeBlocks ? JSON.parse(r.timeBlocks) : [];
                    if (blocks.length > 0) return blocks.map((b: any) => `${b.start}–${b.end}`).join(", ");
                  } catch {}
                  return `${r.startTime}–${r.endTime}`;
                })();
                return (
                  <details key={r.id} className="text-xs bg-background rounded border">
                    <summary className="p-2 cursor-pointer hover:bg-muted/50 flex justify-between items-center">
                      <span><span className="font-medium">{r.date}</span> — {r.property} — {r.calculatedHours}h</span>
                      <span className="font-semibold text-blue-700">${r.entryTotal?.toFixed(2)}</span>
                    </summary>
                    <div className="p-2 pt-0 border-t space-y-1">
                      <div className="grid grid-cols-2 gap-1">
                        <span className="text-muted-foreground">Time</span>
                        <span className="text-right">{timeDisplay}</span>
                        <span className="text-muted-foreground">Hours</span>
                        <span className="text-right">{r.calculatedHours}h</span>
                        <span className="text-muted-foreground">Rate</span>
                        <span className="text-right">${r.rate}/hr{r.isOffSite ? " (off-site)" : ""}</span>
                        <span className="text-muted-foreground">Labor</span>
                        <span className="text-right font-medium">${r.laborCost?.toFixed(2)}</span>
                        <span className="text-muted-foreground">Miles</span>
                        <span className="text-right">{r.miles || "0"} (${r.mileageAmount?.toFixed(2)})</span>
                        <span className="text-muted-foreground">Special Terms</span>
                        <span className="text-right">${r.specialAmount?.toFixed(2)}</span>
                      </div>
                      {r.accomplishmentsList?.length > 0 && (
                        <div className="mt-1">
                          <span className="text-muted-foreground">Accomplishments:</span>
                          <ul className="list-disc list-inside ml-1">
                            {r.accomplishmentsList.map((a: string, i: number) => (
                              <li key={i}>{a}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {r.notes && <p className="text-muted-foreground">Notes: {r.notes}</p>}
                    </div>
                  </details>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

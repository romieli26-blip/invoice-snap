import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { apiRequest, queryClient, getAuthToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Upload, Trash2, Loader2, FileText, Eye, Camera, X, ChevronLeft, ChevronRight, ZoomIn, UserPlus } from "lucide-react";
import { LogoBackground } from "@/components/LogoBackground";
import { compressImage } from "@/lib/compress-image";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface ContractorDocument {
  id: number;
  submittedByUserId: number;
  contractorFirstName: string;
  contractorLastName: string;
  contractorEmail: string | null;
  contractorPhone: string | null;
  docType: string;
  filePath: string | null;
  bankName: string | null;
  routingNumber: string | null;
  accountNumber: string | null;
  createdAt: string;
}

const DOC_TYPE_LABELS: Record<string, string> = {
  photo_id: "Photo ID",
  banking: "Banking Info",
  w9: "W-9 Form",
};

export default function ContractorDocumentsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [contractorFirstName, setContractorFirstName] = useState("");
  const [contractorLastName, setContractorLastName] = useState("");
  const [contractorEmail, setContractorEmail] = useState("");
  const [contractorPhone, setContractorPhone] = useState("");
  const [docType, setDocType] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [viewIdx, setViewIdx] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [bankName, setBankName] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function addFile(f: File | null) {
    if (!f) return;
    setFiles(prev => [...prev, f]);
    const reader = new FileReader();
    reader.onload = () => {
      setPreviews(prev => [...prev, reader.result as string]);
      setViewIdx(previews.length);
    };
    reader.readAsDataURL(f);
  }
  function removeFile(idx: number) {
    setFiles(prev => prev.filter((_, i) => i !== idx));
    setPreviews(prev => prev.filter((_, i) => i !== idx));
    if (viewIdx >= previews.length - 1) setViewIdx(Math.max(0, previews.length - 2));
  }
  function clearFiles() { setFiles([]); setPreviews([]); setViewIdx(0); }

  const { data: documents, isLoading } = useQuery<ContractorDocument[]>({
    queryKey: ["/api/contractor-documents"],
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!contractorFirstName.trim() || !contractorLastName.trim()) {
      toast({ title: "Please enter contractor's first and last name", variant: "destructive" });
      return;
    }
    if (!docType) {
      toast({ title: "Please select a document type", variant: "destructive" });
      return;
    }

    // Photo required for photo_id and w9, optional for banking
    if (files.length === 0 && docType !== "banking") {
      toast({ title: "Please add at least one photo or file", variant: "destructive" });
      return;
    }

    // Validate banking number fields
    if (docType === "banking") {
      if (routingNumber && !/^\d+$/.test(routingNumber)) {
        toast({ title: "Routing number must contain only numbers", variant: "destructive" });
        return;
      }
      if (accountNumber && !/^\d+$/.test(accountNumber)) {
        toast({ title: "Account number must contain only numbers", variant: "destructive" });
        return;
      }
    }

    setSubmitting(true);
    try {
      for (const f of (files.length > 0 ? files : [null])) {
        const formData = new FormData();
        formData.append("contractorFirstName", contractorFirstName.trim());
        formData.append("contractorLastName", contractorLastName.trim());
        if (contractorEmail.trim()) formData.append("contractorEmail", contractorEmail.trim());
        if (contractorPhone.trim()) formData.append("contractorPhone", contractorPhone.trim());
        formData.append("docType", docType);

        if (f) {
          const toUpload = f.type.startsWith("image/") ? await compressImage(f) : f;
          formData.append("document", toUpload);
        }

        if (docType === "banking") {
          formData.append("bankName", bankName);
          formData.append("routingNumber", routingNumber);
          formData.append("accountNumber", accountNumber);
        }

        const token = getAuthToken();
        const res = await fetch(`${API_BASE}/api/contractor-documents`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: formData,
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => null);
          throw new Error(errData?.error || "Upload failed");
        }
      }

      queryClient.invalidateQueries({ queryKey: ["/api/contractor-documents"] });
      toast({ title: `Document uploaded for ${contractorFirstName} ${contractorLastName}` });
      setDocType("");
      clearFiles();
      setBankName("");
      setRoutingNumber("");
      setAccountNumber("");
      // Keep contractor name for multiple doc uploads
    } catch (err: any) {
      toast({ title: "Failed to upload", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this contractor document?")) return;
    try {
      await apiRequest("DELETE", `/api/contractor-documents/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/contractor-documents"] });
      toast({ title: "Document deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  function authUrl(path: string) {
    const token = getAuthToken();
    return `${API_BASE}${path}${token ? `?token=${token}` : ""}`;
  }

  // Group documents by contractor name
  const grouped = new Map<string, ContractorDocument[]>();
  if (documents) {
    for (const doc of documents) {
      const key = `${doc.contractorFirstName} ${doc.contractorLastName}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(doc);
    }
  }

  return (
    <LogoBackground>
      <div className="bg-background min-h-screen p-4 pt-6 pb-12">
        <div className="max-w-lg mx-auto space-y-4">
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>

          <div className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-amber-600" />
            <h1 className="text-xl font-semibold">Contractor Documents</h1>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            Upload documents for external contractors who don't have app accounts.
          </p>

          {/* Upload form */}
          <Card>
            <CardContent className="py-4">
              <form onSubmit={handleSubmit} className="space-y-3">
                {/* Contractor Info */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">First Name *</Label>
                    <Input value={contractorFirstName} onChange={e => setContractorFirstName(e.target.value)} placeholder="First" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Last Name *</Label>
                    <Input value={contractorLastName} onChange={e => setContractorLastName(e.target.value)} placeholder="Last" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={contractorEmail} onChange={e => setContractorEmail(e.target.value)} placeholder="Optional" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Phone</Label>
                    <Input type="tel" value={contractorPhone} onChange={e => setContractorPhone(e.target.value)} placeholder="Optional" />
                  </div>
                </div>

                <div className="border-t pt-3">
                  <div className="space-y-2">
                    <Label>Document Type</Label>
                    <Select value={docType} onValueChange={setDocType}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="photo_id">Photo ID</SelectItem>
                        <SelectItem value="banking">Banking Info</SelectItem>
                        <SelectItem value="w9">W-9 Form</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {docType === "banking" && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">Bank Name</Label>
                      <Input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. Chase" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Routing Number</Label>
                      <Input
                        value={routingNumber}
                        onChange={e => {
                          const v = e.target.value.replace(/\D/g, "");
                          setRoutingNumber(v);
                        }}
                        placeholder="9-digit routing"
                        inputMode="numeric"
                        pattern="[0-9]*"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Account Number</Label>
                      <Input
                        value={accountNumber}
                        onChange={e => {
                          const v = e.target.value.replace(/\D/g, "");
                          setAccountNumber(v);
                        }}
                        placeholder="Account number"
                        inputMode="numeric"
                        pattern="[0-9]*"
                      />
                    </div>
                  </>
                )}

                {docType && (
                  <div className="space-y-2">
                    <Label>{docType === "banking" ? "Voided Check / Direct Deposit Form" : "Upload Photo(s) or Scan"}</Label>
                    
                    {/* Photo carousel preview */}
                    {previews.length > 0 && (
                      <div className="relative rounded-lg overflow-hidden bg-muted">
                        <img src={previews[viewIdx]} alt="Preview" className="w-full max-h-40 object-contain cursor-pointer" onClick={() => setZoomOpen(true)} />
                        {previews.length > 1 && (
                          <div className="absolute bottom-1 left-1/2 -translate-x-1/2 bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded-full">
                            {viewIdx + 1} / {previews.length}
                          </div>
                        )}
                        {previews.length > 1 && viewIdx > 0 && (
                          <button type="button" className="absolute left-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={() => setViewIdx(i => i - 1)}>
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                        )}
                        {previews.length > 1 && viewIdx < previews.length - 1 && (
                          <button type="button" className="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={() => setViewIdx(i => i + 1)}>
                            <ChevronRight className="w-3 h-3" />
                          </button>
                        )}
                        <button type="button" className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => removeFile(viewIdx)}>
                          <X className="w-3 h-3" />
                        </button>
                        <button type="button" className="absolute top-1 left-1 w-6 h-6 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setZoomOpen(true)}>
                          <ZoomIn className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    {/* Add photo buttons */}
                    <div className="flex gap-2">
                      <label className="flex-1 cursor-pointer">
                        <span className="inline-flex items-center justify-center w-full whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3 gap-1">
                          <Camera className="w-3.5 h-3.5" /> {previews.length > 0 ? "Add Photo" : "Take Photo"}
                        </span>
                        <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { addFile(e.target.files?.[0] || null); e.target.value = ""; }} />
                      </label>
                      <label className="flex-1 cursor-pointer">
                        <span className="inline-flex items-center justify-center w-full whitespace-nowrap rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground h-9 px-3 gap-1">
                          <Upload className="w-3.5 h-3.5" /> {previews.length > 0 ? "Add File" : "Upload File"}
                        </span>
                        <input type="file" accept="image/*,.pdf" className="hidden" onChange={e => { addFile(e.target.files?.[0] || null); e.target.value = ""; }} />
                      </label>
                    </div>
                    {previews.length > 0 && (
                      <p className="text-[10px] text-muted-foreground text-center">
                        {previews.length} photo(s) added. Tap photo to zoom.
                      </p>
                    )}
                  </div>
                )}

                <Button type="submit" className="w-full gap-2 bg-amber-600 hover:bg-amber-700" disabled={submitting || !docType || !contractorFirstName.trim() || !contractorLastName.trim()}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Upload Contractor Document
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing contractor documents grouped by contractor */}
          <h2 className="text-sm font-medium text-muted-foreground">Uploaded Contractor Documents</h2>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <Card key={i}><CardContent className="py-3 h-12 animate-pulse bg-muted/30" /></Card>
              ))}
            </div>
          ) : grouped.size > 0 ? (
            <div className="space-y-4">
              {Array.from(grouped.entries()).map(([name, docs]) => (
                <div key={name} className="space-y-2">
                  <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">{name}</h3>
                  {docs.map(doc => (
                    <Card key={doc.id}>
                      <CardContent className="py-3 flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
                          <FileText className="w-5 h-5 text-amber-600" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{DOC_TYPE_LABELS[doc.docType] || doc.docType}</p>
                          {doc.bankName && <p className="text-xs text-muted-foreground">Bank: {doc.bankName}</p>}
                          {doc.routingNumber && <p className="text-xs text-muted-foreground">Routing: ••••{doc.routingNumber.slice(-4)}</p>}
                          {doc.accountNumber && <p className="text-xs text-muted-foreground">Account: ••••{doc.accountNumber.slice(-4)}</p>}
                          {doc.contractorEmail && <p className="text-xs text-muted-foreground">{doc.contractorEmail}</p>}
                          <p className="text-xs text-muted-foreground">{new Date(doc.createdAt).toLocaleDateString()}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {doc.filePath && (
                            <Button variant="ghost" size="icon" asChild>
                              <a href={authUrl(doc.filePath)} target="_blank" rel="noopener noreferrer">
                                <Eye className="w-4 h-4 text-muted-foreground" />
                              </a>
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" onClick={() => handleDelete(doc.id)}>
                            <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive" />
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No contractor documents uploaded yet.</p>
          )}
        </div>
      </div>
      {/* Zoom overlay */}
      {zoomOpen && previews.length > 0 && (
        <div className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4" onClick={() => setZoomOpen(false)}>
          <div className="relative max-w-lg w-full" onClick={e => e.stopPropagation()}>
            <img src={previews[viewIdx]} alt="Zoomed" className="w-full rounded-lg" />
            {previews.length > 1 && (
              <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                {viewIdx + 1} / {previews.length}
              </div>
            )}
            {previews.length > 1 && viewIdx > 0 && (
              <button className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setViewIdx(i => i - 1)}>
                <ChevronLeft className="w-5 h-5" />
              </button>
            )}
            {previews.length > 1 && viewIdx < previews.length - 1 && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setViewIdx(i => i + 1)}>
                <ChevronRight className="w-5 h-5" />
              </button>
            )}
            <button className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center" onClick={() => setZoomOpen(false)}>
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}
    </LogoBackground>
  );
}

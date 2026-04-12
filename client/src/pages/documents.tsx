import { useState } from "react";
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
import { ArrowLeft, Upload, Trash2, Loader2, FileText, Eye, Camera, X } from "lucide-react";
import { useRef } from "react";
import { LogoBackground } from "@/components/LogoBackground";
import { compressImage } from "@/lib/compress-image";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

interface UserDocument {
  id: number;
  userId: number;
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

export default function DocumentsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [docType, setDocType] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [bankName, setBankName] = useState("");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: documents, isLoading } = useQuery<UserDocument[]>({
    queryKey: ["/api/user-documents"],
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!docType) return;

    setSubmitting(true);
    try {
      const formData = new FormData();
      formData.append("docType", docType);

      if (file) {
        // Compress if image
        if (file.type.startsWith("image/")) {
          const compressed = await compressImage(file);
          formData.append("file", compressed);
        } else {
          formData.append("file", file);
        }
      }

      if (docType === "banking") {
        formData.append("bankName", bankName);
        formData.append("routingNumber", routingNumber);
        formData.append("accountNumber", accountNumber);
      }

      const token = getAuthToken();
      const res = await fetch(`${API_BASE}/api/user-documents`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!res.ok) throw new Error("Upload failed");

      queryClient.invalidateQueries({ queryKey: ["/api/user-documents"] });
      toast({ title: "Document uploaded" });
      setDocType("");
      setFile(null);
      setBankName("");
      setRoutingNumber("");
      setAccountNumber("");
    } catch (err: any) {
      toast({ title: "Failed to upload", description: err.message, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm("Delete this document?")) return;
    try {
      await apiRequest("DELETE", `/api/user-documents/${id}`);
      queryClient.invalidateQueries({ queryKey: ["/api/user-documents"] });
      toast({ title: "Document deleted" });
    } catch {
      toast({ title: "Failed to delete", variant: "destructive" });
    }
  }

  function authUrl(path: string) {
    const token = getAuthToken();
    return `${API_BASE}${path}${token ? `?token=${token}` : ""}`;
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
            <FileText className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-semibold">My Documents</h1>
          </div>

          {/* Upload form */}
          <Card>
            <CardContent className="py-4">
              <form onSubmit={handleSubmit} className="space-y-3">
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

                {docType === "banking" && (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">Bank Name</Label>
                      <Input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. Chase" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Routing Number</Label>
                      <Input value={routingNumber} onChange={e => setRoutingNumber(e.target.value)} placeholder="9-digit routing" />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Account Number</Label>
                      <Input value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="Account number" />
                    </div>
                  </>
                )}

                {docType && (
                  <div className="space-y-2">
                    <Label>{docType === "banking" ? "Voided Check / Direct Deposit Form" : "Upload Photo or Scan"}</Label>
                    {file ? (
                      <div className="flex items-center gap-2 bg-muted/50 rounded p-2">
                        <FileText className="w-4 h-4 text-muted-foreground" />
                        <span className="text-sm truncate flex-1">{file.name}</span>
                        <button type="button" onClick={() => setFile(null)} className="text-muted-foreground hover:text-destructive">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Button type="button" variant="outline" size="sm" className="flex-1 gap-1" onClick={() => cameraRef.current?.click()}>
                          <Camera className="w-3.5 h-3.5" /> Take Photo
                        </Button>
                        <Button type="button" variant="outline" size="sm" className="flex-1 gap-1" onClick={() => fileRef.current?.click()}>
                          <Upload className="w-3.5 h-3.5" /> Upload File
                        </Button>
                      </div>
                    )}
                    <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ""; }} />
                    <input ref={fileRef} type="file" accept="image/*,.pdf" className="hidden" onChange={e => { setFile(e.target.files?.[0] || null); e.target.value = ""; }} />
                  </div>
                )}

                <Button type="submit" className="w-full gap-2" disabled={submitting || !docType}>
                  {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                  Upload Document
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Existing documents */}
          <h2 className="text-sm font-medium text-muted-foreground">Uploaded Documents</h2>
          {isLoading ? (
            <div className="space-y-2">
              {[1, 2].map(i => (
                <Card key={i}><CardContent className="py-3 h-12 animate-pulse bg-muted/30" /></Card>
              ))}
            </div>
          ) : documents && documents.length > 0 ? (
            <div className="space-y-2">
              {documents.map(doc => (
                <Card key={doc.id}>
                  <CardContent className="py-3 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <FileText className="w-5 h-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{DOC_TYPE_LABELS[doc.docType] || doc.docType}</p>
                      {doc.bankName && <p className="text-xs text-muted-foreground">{doc.bankName}</p>}
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
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No documents uploaded yet.</p>
          )}
        </div>
      </div>
    </LogoBackground>
  );
}

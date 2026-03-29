import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, Upload, X, Loader2, FileText, Plus, ChevronLeft, ChevronRight } from "lucide-react";
import { apiUpload } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { LogoBackground } from "@/components/LogoBackground";

const isDesktop = typeof window !== "undefined" && !("ontouchstart" in window);

export default function CapturePage() {
  const [, setLocation] = useLocation();
  const [previews, setPreviews] = useState<string[]>([]);
  const [uploadedPaths, setUploadedPaths] = useState<string[]>([]);
  const [currentPreview, setCurrentPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [viewIndex, setViewIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const addMoreFileRef = useRef<HTMLInputElement>(null);
  const addMoreCameraRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
    e.target.value = "";
  }

  function processFile(file: File) {
    setError("");
    const allowedTypes = ["image/jpeg", "image/png", "application/pdf"];
    if (!allowedTypes.includes(file.type)) {
      setError("Invalid file type. Only PNG, JPG, and PDF are allowed.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setError("File too large. Max 4MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      if (previews.length === 0) {
        setCurrentPreview(dataUrl);
      }
      setPreviews(prev => [...prev, dataUrl]);
      setViewIndex(previews.length);
    };
    reader.readAsDataURL(file);
  }

  function removePhoto(index: number) {
    setPreviews(prev => prev.filter((_, i) => i !== index));
    if (viewIndex >= previews.length - 1) setViewIndex(Math.max(0, previews.length - 2));
  }

  async function handleUploadAll() {
    if (previews.length === 0) return;
    setUploading(true);
    setError("");

    try {
      const paths: string[] = [];
      for (const preview of previews) {
        const res = await fetch(preview);
        const blob = await res.blob();
        const formData = new FormData();
        formData.append("photo", blob, `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`);
        const uploadRes = await apiUpload("/api/upload", formData);
        const data = await uploadRes.json();
        paths.push(data.path);
      }

      (window as any).__invoicePhotoPaths = paths;
      (window as any).__invoicePhotoPath = paths[0];
      setLocation("/form");
    } catch (err: any) {
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  const hasPhotos = previews.length > 0;
  const showingPreview = hasPhotos;

  return (
    <LogoBackground>
      <div className="bg-background p-4 pt-6">
      <div className="max-w-lg mx-auto space-y-4">
        <h1 className="text-xl font-semibold" data-testid="text-capture-title">Snap Receipt</h1>
        <p className="text-sm text-muted-foreground">
          {isDesktop ? "Upload or drag and drop images of the receipt." : "Take photos or upload images of the receipt."}
        </p>

        {!showingPreview ? (
          <div
            className={`space-y-3 ${dragging ? "ring-2 ring-primary ring-offset-2 rounded-lg" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) processFile(file);
            }}
          >
            {dragging && (
              <div className="flex items-center justify-center py-8 text-primary font-medium text-sm">
                Drop your file here
              </div>
            )}

            {!isDesktop && (
              <Card
                className="border-2 border-dashed border-primary/30 cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => cameraInputRef.current?.click()}
                data-testid="button-camera"
              >
                <CardContent className="flex flex-col items-center justify-center py-12 gap-3">
                  <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <Camera className="w-8 h-8 text-primary" />
                  </div>
                  <span className="text-sm font-medium">Take Photo</span>
                  <span className="text-xs text-muted-foreground">Opens your camera</span>
                </CardContent>
              </Card>
            )}

            <Card
              className={`cursor-pointer hover:bg-muted/50 transition-colors ${isDesktop ? "border-2 border-dashed border-primary/30" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-upload"
            >
              <CardContent className={`flex ${isDesktop ? "flex-col" : ""} items-center gap-4 ${isDesktop ? "py-12" : "py-4"}`}>
                <div className={`${isDesktop ? "w-16 h-16 rounded-2xl" : "w-10 h-10 rounded-lg"} bg-secondary flex items-center justify-center flex-shrink-0`}>
                  <Upload className={`${isDesktop ? "w-8 h-8" : "w-5 h-5"} text-muted-foreground`} />
                </div>
                <div className={isDesktop ? "text-center" : ""}>
                  <span className="text-sm font-medium block">{isDesktop ? "Upload or Drag & Drop" : "Upload from Gallery"}</span>
                  <span className="text-xs text-muted-foreground">PNG, JPG, PDF — max 4MB</span>
                </div>
              </CardContent>
            </Card>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <input ref={cameraInputRef} type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" className="hidden" onChange={handleFileChange} />
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={handleFileChange} />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Photo carousel */}
            <div className="relative rounded-lg overflow-hidden bg-black/5">
              {previews[viewIndex]?.startsWith("data:application/pdf") ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3 bg-muted/30 rounded-lg">
                  <FileText className="w-16 h-16 text-primary/60" />
                  <p className="text-sm font-medium">PDF Document</p>
                </div>
              ) : (
                <img src={previews[viewIndex]} alt="Receipt" className="w-full max-h-[40vh] object-contain" data-testid="img-preview" />
              )}

              {/* Photo index indicator */}
              {previews.length > 1 && (
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-black/60 text-white text-xs px-2 py-0.5 rounded-full">
                  {viewIndex + 1} / {previews.length}
                </div>
              )}

              {/* Navigation arrows */}
              {previews.length > 1 && viewIndex > 0 && (
                <button className="absolute left-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={() => setViewIndex(i => i - 1)}>
                  <ChevronLeft className="w-4 h-4" />
                </button>
              )}
              {previews.length > 1 && viewIndex < previews.length - 1 && (
                <button className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/40 text-white flex items-center justify-center" onClick={() => setViewIndex(i => i + 1)}>
                  <ChevronRight className="w-4 h-4" />
                </button>
              )}

              {/* Remove current photo */}
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-background/80 backdrop-blur"
                onClick={() => removePhoto(viewIndex)}
                data-testid="button-clear-photo"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* Prompt: Did you capture everything? */}
            <div className="bg-muted/40 rounded-lg p-3 text-center space-y-2">
              <p className="text-sm text-muted-foreground">
                {previews.length === 1
                  ? "Did you capture the whole receipt, or do you need another photo?"
                  : `${previews.length} photos captured. Need to add more?`}
              </p>
              <div className="flex gap-2 justify-center">
                {!isDesktop && (
                  <Button variant="outline" size="sm" className="gap-1" onClick={() => addMoreCameraRef.current?.click()}>
                    <Camera className="w-3.5 h-3.5" />
                    Add Photo
                  </Button>
                )}
                <Button variant="outline" size="sm" className="gap-1" onClick={() => addMoreFileRef.current?.click()}>
                  <Plus className="w-3.5 h-3.5" />
                  {isDesktop ? "Add Another File" : "Add from Gallery"}
                </Button>
              </div>
            </div>

            {/* Hidden inputs for adding more */}
            <input ref={addMoreCameraRef} type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" className="hidden" onChange={handleFileChange} />
            <input ref={addMoreFileRef} type="file" accept="image/jpeg,image/png,application/pdf" className="hidden" onChange={handleFileChange} />

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => { setPreviews([]); setViewIndex(0); setError(""); }}
                data-testid="button-retake"
              >
                Start Over
              </Button>
              <Button
                className="flex-1"
                onClick={handleUploadAll}
                disabled={uploading}
                data-testid="button-continue"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Continue ({previews.length} {previews.length === 1 ? "photo" : "photos"})
              </Button>
            </div>
          </div>
        )}
      </div>
      </div>
    </LogoBackground>
  );
}

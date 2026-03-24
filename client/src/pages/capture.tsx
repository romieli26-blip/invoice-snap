import { useState, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Camera, Upload, X, Loader2 } from "lucide-react";
import { apiUpload } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { LogoBackground } from "@/components/LogoBackground";

export default function CapturePage() {
  const [, setLocation] = useLocation();
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  }

  function processFile(file: File) {
    setError("");
    if (file.size > 10 * 1024 * 1024) {
      setError("File too large. Max 10MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleUpload() {
    if (!preview) return;

    setUploading(true);
    setError("");

    try {
      // Convert data URL to blob
      const res = await fetch(preview);
      const blob = await res.blob();
      const formData = new FormData();
      formData.append("photo", blob, `invoice-${Date.now()}.jpg`);

      const uploadRes = await apiUpload("/api/upload", formData);
      const data = await uploadRes.json();

      // Store photo path in a global and navigate
      (window as any).__invoicePhotoPath = data.path;
      setLocation("/form");
    } catch (err: any) {
      setError("Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <LogoBackground>
      <div className="bg-background p-4 pt-6">
      <div className="max-w-lg mx-auto space-y-4">
        <h1 className="text-xl font-semibold" data-testid="text-capture-title">Snap Invoice</h1>
        <p className="text-sm text-muted-foreground">Take a photo or upload an image of the invoice.</p>

        {!preview ? (
          <div className="space-y-3">
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

            <Card
              className="cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              data-testid="button-upload"
            >
              <CardContent className="flex items-center gap-4 py-4">
                <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
                  <Upload className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <span className="text-sm font-medium block">Upload from Gallery</span>
                  <span className="text-xs text-muted-foreground">JPEG, PNG, WebP — max 10MB</span>
                </div>
              </CardContent>
            </Card>

            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="relative rounded-lg overflow-hidden bg-black/5">
              <img
                src={preview}
                alt="Invoice preview"
                className="w-full max-h-[50vh] object-contain"
                data-testid="img-preview"
              />
              <Button
                variant="secondary"
                size="icon"
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-background/80 backdrop-blur"
                onClick={() => {
                  setPreview(null);
                  setError("");
                }}
                data-testid="button-clear-photo"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setPreview(null);
                  setError("");
                }}
                data-testid="button-retake"
              >
                Retake
              </Button>
              <Button
                className="flex-1"
                onClick={handleUpload}
                disabled={uploading}
                data-testid="button-continue"
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Continue
              </Button>
            </div>
          </div>
        )}
      </div>
      </div>
    </LogoBackground>
  );
}

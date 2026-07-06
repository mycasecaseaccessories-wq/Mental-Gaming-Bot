import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Check, Upload, X, Image as ImageIcon } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api, ApiError, type PaymentMethod } from "@/lib/api";
import { ks, cn } from "@/lib/format";
import { haptic, getTg } from "@/lib/telegram";

const QUICK = [5000, 10000, 25000, 50000, 100000, 200000];
const METHODS = [
  { id: "KPay",    label: "KBZ Pay", shortCode: "KPAY" },
  { id: "WavePay", label: "Wave Pay", shortCode: "WAVE" },
  { id: "AYAPay",  label: "AYA Pay", shortCode: "AYA" },
  { id: "CBPay",   label: "CB Pay", shortCode: "CB" },
] as const;

const MAX_FILE_MB = 6;

export default function TopUpPage() {
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const [amount, setAmount] = useState<number>(10000);
  const [method, setMethod] = useState<typeof METHODS[number]["id"]>("KPay");
  const [copied, setCopied] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pmQ = useQuery({
    queryKey: ["payment-methods"],
    queryFn: () =>
      api.get<{ methods: PaymentMethod[]; note: string | null }>("/payment-methods"),
  });

  const mut = useMutation({
    mutationFn: () => {
      if (!file) throw new ApiError("Please upload your payment screenshot", 400);
      const form = new FormData();
      form.append("amount", String(amount));
      form.append("paymentMethod", method);
      form.append("screenshot", file, file.name);
      return api.postForm<{ requestId: string; txId: string; message: string }>(
        "/topups",
        form
      );
    },
    onSuccess: (data) => {
      haptic("success");
      qc.invalidateQueries({ queryKey: ["wallet"] });
      const tg = getTg();
      if (tg) tg.showAlert(data.message, () => navigate("/wallet"));
      else { alert(data.message); navigate("/wallet"); }
    },
    onError: (e: unknown) => {
      haptic("error");
      const tg = getTg();
      const msg = e instanceof ApiError ? e.message : "Top-up failed";
      if (tg) tg.showAlert(msg); else alert(msg);
    },
  });

  function pickFile(f: File | null) {
    setFileError(null);
    if (!f) { setFile(null); setPreview(null); return; }
    if (!/^image\/(png|jpe?g|webp)$/i.test(f.type)) {
      setFileError("Only PNG, JPEG, or WebP images allowed");
      return;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      setFileError(`Image too large (max ${MAX_FILE_MB} MB)`);
      return;
    }
    haptic("light");
    setFile(f);
    const url = URL.createObjectURL(f);
    setPreview(url);
  }

  function clearFile() {
    haptic("light");
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function copyText(t: string, id: string) {
    haptic("light");
    navigator.clipboard?.writeText(t).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  const matched = pmQ.data?.methods.filter((m) =>
    m.label.toLowerCase().includes(method.replace("Pay", "").toLowerCase())
  ) ?? [];

  const statusByCode = new Map(
    (pmQ.data?.methods ?? []).map((m) => [(m.shortCode || "").toUpperCase(), m.status ?? "Online"]),
  );
  const statusOf = (shortCode: string) => statusByCode.get(shortCode) ?? "Online";
  const gatewayNote = pmQ.data?.note ?? null;
  const selectedStatus = statusOf(
    METHODS.find((m) => m.id === method)?.shortCode ?? "",
  );
  const selectedOffline = selectedStatus === "Offline";

  const canSubmit = amount >= 1000 && !!file && !mut.isPending && !selectedOffline;

  return (
    <Layout title="Top Up" showBack showNav={false}>
      <div className="space-y-4 pb-32">
        {/* Amount */}
        <Glass className="p-4">
          <div className="text-xs font-medium text-muted-foreground mb-2">Amount (KS)</div>
          <div className="text-3xl font-bold">
            <input
              type="number"
              min={1000}
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
              className="bg-transparent outline-none w-full"
              data-testid="input-amount"
            />
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            {QUICK.map((v) => (
              <button
                key={v}
                onClick={() => { haptic("selection"); setAmount(v); }}
                className={cn(
                  "pressable rounded-xl py-2 text-sm font-medium border",
                  amount === v ? "bg-primary text-white border-primary" : "glass border-white/10"
                )}
                data-testid={`quick-${v}`}
              >
                {ks(v)}
              </button>
            ))}
          </div>
        </Glass>

        {/* Payment method */}
        <div>
          <div className="text-xs font-medium text-muted-foreground mb-2 px-1">Payment method</div>
          <div className="grid grid-cols-2 gap-2">
            {METHODS.map((m) => {
              const st = statusOf(m.shortCode);
              const offline = st === "Offline";
              return (
                <button
                  key={m.id}
                  disabled={offline}
                  onClick={() => { haptic("selection"); setMethod(m.id); }}
                  className={cn(
                    "pressable rounded-2xl p-3 text-sm font-medium border text-left disabled:opacity-40",
                    method === m.id ? "glass-blue border-primary/50" : "glass border-white/10"
                  )}
                  data-testid={`method-${m.id}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <span>{m.label}</span>
                    {st !== "Online" && (
                      <span
                        className={cn(
                          "text-[10px] font-semibold rounded px-1.5 py-0.5",
                          offline
                            ? "bg-rose-500/20 text-rose-300"
                            : "bg-amber-500/20 text-amber-300"
                        )}
                      >
                        {offline ? "Offline" : "Busy"}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {gatewayNote && (
          <Glass className="p-3 text-xs text-amber-200/90 leading-relaxed">
            ⚠️ {gatewayNote}
          </Glass>
        )}

        {selectedOffline && (
          <Glass className="p-3 text-xs text-rose-300 leading-relaxed">
            This payment method is temporarily unavailable. Please choose another.
          </Glass>
        )}

        {/* Account info */}
        {pmQ.isLoading ? (
          <Skeleton className="h-24" />
        ) : matched.length > 0 ? (
          <Glass className="p-4 space-y-3">
            <div className="text-xs font-medium text-muted-foreground">Send to</div>
            {matched.map((m) => (
              <div key={m.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{m.accountName}</div>
                  <div className="text-xs font-mono text-muted-foreground truncate">{m.accountNumber}</div>
                </div>
                <button
                  onClick={() => copyText(m.accountNumber, m.id)}
                  className="pressable glass-strong rounded-xl h-9 w-9 flex items-center justify-center"
                  data-testid={`copy-${m.id}`}
                >
                  {copied === m.id ? <Check className="h-4 w-4 text-emerald-300" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
            ))}
          </Glass>
        ) : (
          <Glass className="p-4 text-sm text-muted-foreground">
            No account info on file for this gateway yet — please contact support after submitting.
          </Glass>
        )}

        {/* Screenshot upload */}
        <Glass className="p-4">
          <div className="text-xs font-medium text-muted-foreground mb-2">
            Payment screenshot <span className="text-rose-300">*</span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
            data-testid="input-screenshot"
          />

          {preview ? (
            <div className="relative rounded-2xl overflow-hidden border border-white/10">
              <img
                src={preview}
                alt="Payment screenshot preview"
                className="w-full max-h-80 object-contain bg-black/40"
              />
              <button
                onClick={clearFile}
                className="pressable absolute top-2 right-2 glass-strong rounded-full h-9 w-9 flex items-center justify-center"
                data-testid="button-clear-screenshot"
                aria-label="Remove screenshot"
              >
                <X className="h-4 w-4" />
              </button>
              <div className="absolute bottom-2 left-2 right-12 text-[11px] glass-strong rounded-lg px-2 py-1 truncate">
                <ImageIcon className="inline h-3 w-3 mr-1 -mt-0.5" />
                {file?.name} · {((file?.size ?? 0) / 1024).toFixed(0)} KB
              </div>
            </div>
          ) : (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="pressable w-full glass border border-dashed border-white/15 rounded-2xl py-8 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground"
              data-testid="button-upload-screenshot"
            >
              <Upload className="h-6 w-6" />
              <div className="font-medium text-foreground">Upload payment screenshot</div>
              <div className="text-[11px]">PNG / JPG / WebP · max {MAX_FILE_MB} MB</div>
            </button>
          )}

          {fileError && (
            <div className="mt-2 text-xs text-rose-300" data-testid="text-file-error">
              {fileError}
            </div>
          )}
        </Glass>

        <Glass className="p-3 text-xs text-muted-foreground leading-relaxed">
          Your screenshot is sent securely to the admin for review. Most top-ups
          are approved within minutes.
        </Glass>

        {/* Submit */}
        <div className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3 bg-gradient-to-t from-background to-transparent">
          <button
            disabled={!canSubmit}
            onClick={() => mut.mutate()}
            className="pressable w-full bg-primary text-white rounded-2xl py-4 font-semibold disabled:opacity-40"
            data-testid="button-submit-topup"
          >
            {mut.isPending
              ? "Submitting…"
              : !file
                ? "Upload screenshot to continue"
                : `Submit top-up of ${ks(amount)}`}
          </button>
        </div>
      </div>
    </Layout>
  );
}

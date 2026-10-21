import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Edit3, PackagePlus, Search, ToggleLeft, ToggleRight } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Glass } from "@/components/Glass";
import { Skeleton } from "@/components/EmptyState";
import { api } from "@/lib/api";
import { ks } from "@/lib/format";

type Product = { id: string; name: string; category: string; region: string; productType: string; finalPrice: number; flashSalePrice: number | null; stockCount: number; isActive: boolean; status: string; imageUrl: string | null; description: string };
type Form = Omit<Product, "id" | "isActive" | "status" | "flashSalePrice" | "stockCount" | "imageUrl" | "description"> & { flashSalePrice: string; stockCount: string; imageUrl: string; description: string; isActive: boolean; status: string };
const empty: Form = { name: "", category: "", region: "Global", productType: "DirectTopup", finalPrice: 0, flashSalePrice: "", stockCount: "-1", imageUrl: "", description: "", isActive: true, status: "active" };

export default function AdminProducts() {
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const qc = useQueryClient();
  const q = useQuery<{ items: Product[] }>({ queryKey: ["admin-products", search], queryFn: () => api.get(`/admin/products?search=${encodeURIComponent(search)}`) });
  const save = useMutation({ mutationFn: async (value: Form) => { if (value.name && (value as Form & { id?: string }).id) return api.patch(`/admin/products/${(value as Form & { id: string }).id}`, value); return api.post("/admin/products", value); }, onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ["admin-products"] }); } });
  const toggle = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/admin/products/${id}`, { isActive: active, status: active ? "active" : "hidden" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-products"] }) });

  return <Layout title="Products" showBack showNav>
    <div className="mx-auto max-w-6xl space-y-4 pb-10">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center"><div className="flex flex-1 items-center gap-2 rounded-xl border border-white/10 bg-white/[.04] px-3 py-2"><Search className="h-4 w-4 text-muted-foreground" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products or category…" className="w-full bg-transparent text-sm outline-none" /></div><button onClick={() => setForm(empty)} className="pressable inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold"><PackagePlus className="h-4 w-4" /> Add product</button></div>
      {form && <ProductForm value={form} setValue={setForm} saving={save.isPending} onCancel={() => setForm(null)} onSave={() => save.mutate(form)} />}
      {q.isLoading ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><Skeleton className="h-40" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{(q.data?.items ?? []).map((p) => <Glass key={p.id} className="overflow-hidden"><div className="flex gap-3 p-4"><div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-white/5">{p.imageUrl ? <img src={p.imageUrl} alt="" className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-2xl">🎮</div>}</div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">{p.name}</div><div className="mt-1 text-xs text-muted-foreground">{p.category} · {p.region}</div><div className="mt-2 font-bold text-primary">{ks(p.flashSalePrice ?? p.finalPrice)}</div></div></div><div className="flex items-center gap-2 border-t border-white/5 px-4 py-3 text-xs"><span className={p.isActive ? "text-emerald-400" : "text-rose-400"}>{p.isActive ? "Active" : "Hidden"}</span><span className="text-muted-foreground">Stock: {p.stockCount < 0 ? "Unlimited" : p.stockCount}</span><button onClick={() => setForm({ ...p, flashSalePrice: p.flashSalePrice?.toString() ?? "", stockCount: p.stockCount.toString(), imageUrl: p.imageUrl ?? "", isActive: p.isActive, status: p.status })} className="ml-auto rounded-lg p-1.5 text-muted-foreground hover:bg-white/10 hover:text-white"><Edit3 className="h-4 w-4" /></button><button onClick={() => toggle.mutate({ id: p.id, active: !p.isActive })} className="rounded-lg p-1.5 text-muted-foreground hover:bg-white/10 hover:text-white">{p.isActive ? <ToggleRight className="h-5 w-5 text-emerald-400" /> : <ToggleLeft className="h-5 w-5" />}</button></div></Glass>)}</div>}
    </div>
  </Layout>;
}

function ProductForm({ value, setValue, saving, onCancel, onSave }: { value: Form; setValue: (v: Form) => void; saving: boolean; onCancel: () => void; onSave: () => void }) {
  const field = (key: keyof Form, label: string, type = "text") => <label className="space-y-1 text-xs text-muted-foreground"><span>{label}</span><input type={type} value={String(value[key] ?? "")} onChange={(e) => setValue({ ...value, [key]: type === "number" ? Number(e.target.value) : e.target.value })} className="w-full rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-primary" /></label>;
  return <Glass className="space-y-4 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold">{(value as Form & { id?: string }).id ? "Edit product" : "New product"}</h2><span className="text-xs text-muted-foreground">Changes apply to the public store</span></div><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{field("name", "Product name")}{field("category", "Category")}{field("region", "Region")}{field("finalPrice", "Price (Ks)", "number")}{field("flashSalePrice", "Sale price (optional)", "number")}{field("stockCount", "Stock (-1 unlimited)", "number")}{field("imageUrl", "Image URL")}{field("description", "Description")}</div><div className="flex justify-end gap-2"><button onClick={onCancel} className="rounded-xl border border-white/10 px-4 py-2 text-sm">Cancel</button><button disabled={saving} onClick={onSave} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold disabled:opacity-50">{saving ? "Saving…" : "Save product"}</button></div></Glass>;
}

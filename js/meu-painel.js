"use strict";

// /meu-painel — métricas do próprio vendedor (só o bloco dele vem do servidor)

function escapeHtml(t) { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; }
async function chamarApi(url) {
  const r = await fetch(url);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || `erro ${r.status}`);
  return corpo;
}
const reais = (c) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format((c || 0) / 100);
const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const pct = (p) => (p == null ? "—" : p.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%");
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dataBr = (s) => (s ? s.split("-").reverse().join("/") : "");
function avisar(texto) { const el = document.getElementById("aviso"); el.textContent = texto; el.classList.add("visivel"); clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), 5000); }

function periodoPredefinido(tipo) {
  const hoje = new Date();
  if (tipo === "mes") return [iso(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), iso(hoje)];
  if (tipo === "mes-anterior") return [iso(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1)), iso(new Date(hoje.getFullYear(), hoje.getMonth(), 0))];
  const seg = new Date(hoje); seg.setDate(hoje.getDate() - ((hoje.getDay() + 6) % 7));
  return [iso(seg), iso(hoje)];
}

const card = (rotulo, valor, extra = "", classe = "") => `<div class="metrica-card"><span class="metrica-rotulo">${escapeHtml(rotulo)}</span>
  <span class="metrica-valor ${classe}">${valor}</span><span class="metrica-extra">${extra}</span></div>`;
const classePct = (p) => (p == null ? "" : p >= 100 ? "pct-ok" : p >= 70 ? "pct-meio" : "pct-baixo");

async function carregar(de, ate) {
  document.getElementById("p-de").value = de; document.getElementById("p-ate").value = ate;
  document.getElementById("legenda").textContent = `${dataBr(de)} a ${dataBr(ate)}`;
  const m = await chamarApi(`/api/metricas?de=${de}&ate=${ate}`);
  const eu = m.minha;
  if (!eu) {
    document.getElementById("cards").innerHTML = card("Sem consultor ligado", "—", "seu usuário ainda não está ligado a um consultor — peça ao administrador");
    return;
  }
  const meta = (c) => (c.meta != null ? ` / ${c.meta.toLocaleString("pt-BR")}` : "");
  document.getElementById("cards").innerHTML = [
    card("Ligações discadas", `${inteiro(eu.ligacoes.discadas.valor)}<small>${meta(eu.ligacoes.discadas)}</small>`, `${eu.ligacoes.atendidas} atendidas · taxa ${pct(eu.ligacoes.taxaAtendimento)} · TMA ${eu.ligacoes.tmaSeg != null ? eu.ligacoes.tmaSeg + " s" : "—"}`, classePct(eu.ligacoes.discadas.atingimento)),
    card("Leads novos", `${inteiro(eu.funil.leadsNovos.valor)}<small>${meta(eu.funil.leadsNovos)}</small>`, `${eu.funil.perdidas} perdidas · ${eu.funil.vendas} vendas no CRM`, classePct(eu.funil.leadsNovos.atingimento)),
    card("Matrículas", `${inteiro(eu.matriculas.valor)}<small>${meta(eu.matriculas)}</small>`, `atingimento ${pct(eu.matriculas.atingimento)}`, classePct(eu.matriculas.atingimento)),
    card("Receita", reais(eu.receitaCentavos), eu.receita.meta != null ? `meta ${reais(eu.receita.meta)} · ${pct(eu.receita.atingimento)}` : "sem meta de receita cadastrada", classePct(eu.receita.atingimento)),
    card("Dias úteis no período", inteiro(m.diasUteis), "seg–sex, sem feriados"),
  ].join("");
}

function aplicar() {
  const de = document.getElementById("p-de").value, ate = document.getElementById("p-ate").value;
  if (!de || !ate || ate < de) return avisar("Informe um intervalo válido.");
  carregar(de, ate).catch((e) => avisar("⚠ " + e.message));
}
for (const b of document.querySelectorAll("button[data-periodo]")) b.addEventListener("click", () => carregar(...periodoPredefinido(b.dataset.periodo)).catch((e) => avisar("⚠ " + e.message)));
document.getElementById("btn-aplicar").addEventListener("click", aplicar);
document.getElementById("btn-sair").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.href = "/login"; });

(async () => {
  try {
    const s = await chamarApi("/api/sessao");
    document.getElementById("intro").textContent = `${s.nome}${s.pessoa ? " (" + s.pessoa.nome + ")" : ""} — seus números no período, pelo mesmo motor dos relatórios. Só os seus.`;
    const regs = s.escopo?.regionais || [];
    document.getElementById("regionais").innerHTML = regs.length
      ? regs.map((r) => `<a class="chip chip-cliente" href="/territorio#/r/${r.id}">${escapeHtml(r.uf)} · ${escapeHtml(r.sigla)}</a>`).join(" ")
      : "Nenhuma regional atribuída ainda — peça ao administrador.";
    await carregar(...periodoPredefinido("mes"));
  } catch (e) { avisar("⚠ " + e.message); }
})();

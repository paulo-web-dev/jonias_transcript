"use strict";

// /usuarios (admin): criação de usuários com senha inicial, ativação, papel e
// consultor ligado; carteiras por regional (titular + apoios).

function escapeHtml(t) {
  const d = document.createElement("div");
  d.textContent = t ?? "";
  return d.innerHTML;
}
async function chamarApi(url, opcoes) {
  const r = await fetch(url, opcoes);
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.error || `erro ${r.status}`);
  return corpo;
}
const postJson = (url, corpo, metodo = "POST") =>
  chamarApi(url, { method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
const inteiro = (n) => (n || 0).toLocaleString("pt-BR");
const dataHoraBr = (iso) => { if (!iso) return "nunca"; const d = new Date(iso); return isNaN(d) ? String(iso) : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }); };
function avisar(texto, erro = false) {
  const el = document.getElementById("aviso");
  el.textContent = texto; el.classList.toggle("aviso-erro", erro); el.classList.add("visivel");
  clearTimeout(avisar.t); avisar.t = setTimeout(() => el.classList.remove("visivel"), erro ? 6000 : 3000);
}

let dados = { usuarios: [], pessoas: [] };
let carteiras = { regionais: [], pessoas: [] };

function mostrarSenhaInicial(login, senha) {
  const box = document.getElementById("senha-inicial");
  box.innerHTML = `Senha inicial de <strong>${escapeHtml(login)}</strong>: <code class="senha-inicial-valor">${escapeHtml(senha)}</code>
    <button type="button" class="btn-mini" id="btn-copiar-senha">copiar</button>
    <span class="texto-suave">— mostrada só agora; entregue ao usuário, que troca no primeiro acesso.</span>`;
  box.classList.remove("oculto");
  document.getElementById("btn-copiar-senha").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(senha); avisar("Senha copiada."); } catch (_) { avisar("Copie manualmente.", true); }
  });
}

function renderizarUsuarios() {
  document.getElementById("chip-usuarios").textContent = dados.usuarios.length;
  const sel = document.getElementById("u-pessoa");
  sel.innerHTML = `<option value="">consultor (pessoas)…</option>` + dados.pessoas.map((p) => `<option value="${p.id}">${escapeHtml(p.nome)}${p.ativo ? "" : " (inativo)"}</option>`).join("");
  document.querySelector("#tabela-usuarios tbody").innerHTML = dados.usuarios.map((u) => `<tr class="sem-clique" data-id="${u.id}">
    <td class="celula-nome">${escapeHtml(u.login)}</td><td style="text-align:left">${escapeHtml(u.nome)}</td>
    <td><select class="campo-select campo-papel"><option value="admin" ${u.papel === "admin" ? "selected" : ""}>admin</option><option value="vendedor" ${u.papel === "vendedor" ? "selected" : ""}>vendedor</option></select></td>
    <td style="text-align:left"><select class="campo-select campo-pessoa"><option value="">—</option>${dados.pessoas.map((p) => `<option value="${p.id}" ${p.id === u.pessoaId ? "selected" : ""}>${escapeHtml(p.nome)}</option>`).join("")}</select></td>
    <td><input type="checkbox" class="campo-ativo" ${u.ativo ? "checked" : ""} /></td>
    <td>${u.senhaTemporaria ? '<span class="pct-meio" title="ainda não trocou a senha inicial">temporária</span>' : '<span class="saude-ok">própria</span>'}</td>
    <td class="texto-suave">${escapeHtml(dataHoraBr(u.ultimoAcessoEm))}</td>
    <td style="text-align:left"><button type="button" class="btn-mini" data-acao="senha">nova senha inicial</button></td>
  </tr>`).join("");
}

async function carregarUsuarios() {
  dados = await chamarApi("/api/usuarios");
  renderizarUsuarios();
}

document.getElementById("btn-criar-usuario").addEventListener("click", async () => {
  const corpo = { login: document.getElementById("u-login").value, nome: document.getElementById("u-nome").value, papel: document.getElementById("u-papel").value, pessoaId: document.getElementById("u-pessoa").value || null };
  try {
    const r = await postJson("/api/usuarios", corpo);
    mostrarSenhaInicial(r.usuario.login, r.senhaInicial);
    document.getElementById("u-login").value = ""; document.getElementById("u-nome").value = "";
    await Promise.all([carregarUsuarios(), carregarCarteiras()]);
    avisar(`Usuário "${r.usuario.login}" criado.`);
  } catch (e) { avisar("⚠ " + e.message, true); }
});
document.getElementById("u-papel").addEventListener("change", (ev) => { document.getElementById("u-pessoa").disabled = ev.target.value !== "vendedor"; });

document.getElementById("tabela-usuarios").addEventListener("change", async (ev) => {
  const tr = ev.target.closest("tr[data-id]");
  if (!tr) return;
  const corpo = {};
  if (ev.target.classList.contains("campo-papel")) corpo.papel = ev.target.value;
  if (ev.target.classList.contains("campo-pessoa")) corpo.pessoaId = ev.target.value ? Number(ev.target.value) : null;
  if (ev.target.classList.contains("campo-ativo")) corpo.ativo = ev.target.checked;
  try {
    await postJson(`/api/usuarios/${tr.dataset.id}`, corpo, "PATCH");
    avisar("Usuário atualizado.");
    await Promise.all([carregarUsuarios(), carregarCarteiras()]);
  } catch (e) { avisar("⚠ " + e.message, true); await carregarUsuarios(); }
});
document.getElementById("tabela-usuarios").addEventListener("click", async (ev) => {
  const b = ev.target.closest("button[data-acao='senha']");
  if (!b) return;
  const tr = b.closest("tr[data-id]");
  try {
    const r = await postJson(`/api/usuarios/${tr.dataset.id}/senha-inicial`, {});
    mostrarSenhaInicial(r.login, r.senhaInicial);
    await carregarUsuarios();
  } catch (e) { avisar("⚠ " + e.message, true); }
});

// ---------- Carteiras ----------

function renderizarCarteiras() {
  const opcoes = (sel) => `<option value="">—</option>` + carteiras.pessoas.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${escapeHtml(p.nome)}${p.temUsuario ? "" : " (sem usuário)"}</option>`).join("");
  document.querySelector("#tabela-carteiras tbody").innerHTML = carteiras.regionais.map((r) => `<tr class="sem-clique" data-id="${r.id}">
    <td>${escapeHtml(r.uf)}</td><td class="celula-nome">${escapeHtml(r.sigla)}<div class="texto-suave territorio-descricao">${escapeHtml(r.nome || "")}</div></td>
    <td>${inteiro(r.contatos)}</td><td>${r.semConsultor ? `<span class="pct-meio">${inteiro(r.semConsultor)}</span>` : "0"}</td>
    <td style="text-align:left"><select class="campo-select campo-titular">${opcoes(r.titular?.pessoaId ?? null)}</select></td>
    <td style="text-align:left" class="carteira-apoios">${carteiras.pessoas.map((p) => `<label class="trab-flag"><input type="checkbox" class="campo-apoio" value="${p.id}" ${r.apoios.some((a) => a.pessoaId === p.id) ? "checked" : ""} /> ${escapeHtml(p.nome)}</label>`).join(" ")}</td>
    <td style="text-align:left" class="texto-suave carteira-resultado">${r.titular ? `titular: ${escapeHtml(r.titular.nome)}` : "sem titular"}</td>
  </tr>`).join("") || `<tr class="sem-clique"><td colspan="7" class="texto-suave">Nenhuma regional carregada.</td></tr>`;
}

async function carregarCarteiras() {
  carteiras = await chamarApi("/api/carteiras");
  renderizarCarteiras();
}

document.getElementById("tabela-carteiras").addEventListener("change", async (ev) => {
  const tr = ev.target.closest("tr[data-id]");
  if (!tr) return;
  const titular = tr.querySelector(".campo-titular").value || null;
  const apoios = [...tr.querySelectorAll(".campo-apoio:checked")].map((c) => Number(c.value)).filter((id) => String(id) !== String(titular));
  try {
    const r = await postJson(`/api/carteiras/${tr.dataset.id}`, { titularPessoaId: titular, apoios }, "PUT");
    carteiras = r.carteiras;
    renderizarCarteiras();
    const linha = document.querySelector(`#tabela-carteiras tr[data-id="${tr.dataset.id}"] .carteira-resultado`);
    if (linha) linha.innerHTML = `${linha.innerHTML} · <strong class="saude-ok">${inteiro(r.atribuidos)} contato(s) passaram para o titular</strong>`;
    avisar(r.atribuidos ? `${inteiro(r.atribuidos)} contato(s) sem consultor atribuídos ao titular.` : "Carteira salva.");
  } catch (e) { avisar("⚠ " + e.message, true); await carregarCarteiras(); }
});

document.getElementById("btn-sair").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

(async () => {
  try { await Promise.all([carregarUsuarios(), carregarCarteiras()]); }
  catch (e) { avisar("⚠ Não foi possível carregar. (" + e.message + ")", true); }
})();

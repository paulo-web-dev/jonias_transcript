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
  // pessoa: consultor (vendedor) ou administrativo (patrimônio/colaborador, migração 44)
  const rotuloPessoa = (p) => `${escapeHtml(p.nome)}${p.tipo === "administrativo" ? " · adm." : ""}${p.ativo ? "" : " (inativo)"}`;
  sel.innerHTML = `<option value="">pessoa…</option>` + dados.pessoas.map((p) => `<option value="${p.id}">${rotuloPessoa(p)}</option>`).join("");
  const papeis = ["admin", "vendedor", "marketing", "patrimonio", "colaborador"];
  document.querySelector("#tabela-usuarios tbody").innerHTML = dados.usuarios.map((u) => `<tr class="sem-clique" data-id="${u.id}">
    <td class="celula-nome">${escapeHtml(u.login)}</td><td style="text-align:left">${escapeHtml(u.nome)}</td>
    <td><select class="campo-select campo-papel">${papeis.map((p) => `<option value="${p}" ${u.papel === p ? "selected" : ""}>${p}</option>`).join("")}</select></td>
    <td style="text-align:left"><select class="campo-select campo-pessoa"><option value="">—</option>${dados.pessoas.map((p) => `<option value="${p.id}" ${p.id === u.pessoaId ? "selected" : ""}>${rotuloPessoa(p)}</option>`).join("")}</select></td>
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
// marketing não tem pessoa; vendedor e colaborador exigem; admin e patrimonio, opcional (o servidor valida o tipo)
document.getElementById("u-papel").addEventListener("change", (ev) => { document.getElementById("u-pessoa").disabled = ev.target.value === "marketing"; });

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
    await Promise.all([carregarUsuarios(), carregarAdm(), carregarCarteiras()]);
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

// ---------- Pessoas administrativas (2026-11-28) ----------
// Cadastro, correção de nome e desativação sem migração. Consultor não entra
// por aqui (o servidor fixa o tipo). Desativar bloqueado vira lista de trabalho:
// os itens no nome da pessoa (código e nome) com o atalho para a devolução.

let adm = [];
async function chamarApiCompleta(url, corpo, metodo) {
  const r = await fetch(url, { method: metodo, headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) });
  if (r.status === 401) { location.href = "/login"; throw new Error("sessão expirada"); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `erro ${r.status}`), { corpo: j });
  return j;
}
const ROTULO_STATUS_ITEM = { em_uso: "em uso", em_estoque: "em estoque", em_reparo: "em reparo", baixado: "baixado" };

function renderizarAdm() {
  document.getElementById("chip-adm").textContent = adm.filter((p) => p.ativo).length;
  document.querySelector("#tabela-adm tbody").innerHTML = adm.map((p) => `<tr class="sem-clique${p.ativo ? "" : " linha-inativa"}" data-id="${p.id}">
    <td style="text-align:left"><input type="text" class="campo-select adm-nome" value="${escapeHtml(p.nome)}" maxlength="80" title="corrigir o nome: salva ao sair do campo" /></td>
    <td>${p.ativo ? '<span class="saude-ok">ativa</span>' : '<span class="texto-suave">inativa</span>'}</td>
    <td style="text-align:left">${p.usuario ? `${escapeHtml(p.usuario)}${p.usuarioAtivo ? "" : ' <span class="texto-suave">(inativo)</span>'}` : '<span class="texto-suave">—</span>'}</td>
    <td>${p.itens ? `<a href="/patrimonio#pessoa=${p.id}">${inteiro(p.itens)}</a>` : "0"}</td>
    <td style="text-align:left"><button type="button" class="btn-mini" data-adm-ativo="${p.ativo ? 0 : 1}">${p.ativo ? "desativar" : "reativar"}</button></td>
  </tr>`).join("") || `<tr class="sem-clique"><td colspan="5" class="texto-suave">Nenhuma pessoa administrativa.</td></tr>`;
}
async function carregarAdm() {
  adm = (await chamarApi("/api/pessoas-administrativas")).pessoas;
  renderizarAdm();
}
function mostrarBloqueio(p, corpo) {
  const box = document.getElementById("adm-bloqueio");
  const itens = corpo.itens || [];
  box.innerHTML = `<strong>${escapeHtml(corpo.error || "Não foi possível desativar.")}</strong>` +
    (corpo.usuario ? `<p>Usuário <strong>${escapeHtml(corpo.usuario.login)}</strong>: desmarque “Ativo” na tabela de usuários acima.</p>` : "") +
    (itens.length ? `<p>Itens no nome de ${escapeHtml(p.nome)}:</p><ul class="adm-itens">${itens.map((i) =>
      `<li><code>${escapeHtml(i.codigo)}</code> ${escapeHtml(i.nome)} <span class="texto-suave">· ${ROTULO_STATUS_ITEM[i.status] || i.status}${i.local ? ` · ${escapeHtml(i.local)}` : ""}${i.comTermo ? " · termo assinado" : " · sem termo"}</span></li>`).join("")}</ul>
      <p><a class="btn-mini btn-primario" href="${escapeHtml(corpo.devolucao)}">↩ Abrir a devolução desses itens no patrimônio</a>
      <span class="texto-suave">— depois volte aqui e desative.</span></p>` : "");
  box.classList.remove("oculto");
  box.scrollIntoView({ block: "nearest" });
}

document.getElementById("btn-criar-adm").addEventListener("click", async () => {
  const campo = document.getElementById("adm-nome");
  try {
    const r = await postJson("/api/pessoas-administrativas", { nome: campo.value });
    campo.value = "";
    await Promise.all([carregarAdm(), carregarUsuarios()]);
    avisar(`"${r.pessoa.nome}" cadastrada — já pode ser ligada a um usuário e receber patrimônio.`);
  } catch (e) { avisar("⚠ " + e.message, true); }
});
document.getElementById("adm-nome").addEventListener("keydown", (ev) => { if (ev.key === "Enter") document.getElementById("btn-criar-adm").click(); });
document.getElementById("tabela-adm").addEventListener("change", async (ev) => {
  const tr = ev.target.closest("tr[data-id]"); if (!tr || !ev.target.classList.contains("adm-nome")) return;
  try {
    const r = await postJson(`/api/pessoas-administrativas/${tr.dataset.id}`, { nome: ev.target.value }, "PATCH");
    avisar(`Nome salvo: ${r.pessoa.nome}.`);
    await Promise.all([carregarAdm(), carregarUsuarios()]);
  } catch (e) { avisar("⚠ " + e.message, true); await carregarAdm(); }
});
document.getElementById("tabela-adm").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-adm-ativo]"); if (!b) return;
  const tr = b.closest("tr[data-id]");
  const p = adm.find((x) => x.id === Number(tr.dataset.id));
  document.getElementById("adm-bloqueio").classList.add("oculto");
  try {
    await chamarApiCompleta(`/api/pessoas-administrativas/${p.id}`, { ativo: b.dataset.admAtivo === "1" }, "PATCH");
    avisar(b.dataset.admAtivo === "1" ? `${p.nome} reativada.` : `${p.nome} desativada — sai dos seletores de novo responsável; o histórico fica.`);
    await Promise.all([carregarAdm(), carregarUsuarios()]);
  } catch (e) {
    if (e.corpo && (e.corpo.itens || e.corpo.usuario)) mostrarBloqueio(p, e.corpo);
    else avisar("⚠ " + e.message, true);
  }
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
  try { await Promise.all([carregarUsuarios(), carregarAdm(), carregarCarteiras()]); }
  catch (e) { avisar("⚠ Não foi possível carregar. (" + e.message + ")", true); }
})();

"use strict";

const el = {
  arquivoCdr: document.getElementById("arquivo-cdr"),
  arquivoOportunidades: document.getElementById("arquivo-oportunidades"),
  arquivoProspeccao: document.getElementById("arquivo-prospeccao"),
  prospeccaoUf: document.getElementById("prospeccao-uf"),
  prospeccaoStatus: document.getElementById("prospeccao-status"),
  cdrStatus: document.getElementById("cdr-status"),
  oportunidadesStatus: document.getElementById("oportunidades-status"),
  mysqlStatus: document.getElementById("mysql-status"),
  btnSincronizar: document.getElementById("btn-sincronizar"),
  relatorio: document.getElementById("relatorio"),
  relatorioTitulo: document.getElementById("relatorio-titulo"),
  relatorioConteudo: document.getElementById("relatorio-conteudo"),
  btnFecharRelatorio: document.getElementById("btn-fechar-relatorio"),
  lista: document.getElementById("lista-importacoes"),
  vazio: document.getElementById("importacoes-vazio"),
  aviso: document.getElementById("aviso"),
  btnSair: document.getElementById("btn-sair"),
  tvSomStatus: document.getElementById("tv-som-status"),
  btnTvSom: document.getElementById("btn-tv-som"),
};

let avisoTimerId = null;

function escapeHtml(texto) {
  const div = document.createElement("div");
  div.textContent = texto ?? "";
  return div.innerHTML;
}

function mostrarAviso(mensagem) {
  el.aviso.textContent = "⚠ " + mensagem;
  el.aviso.classList.add("visivel");
  clearTimeout(avisoTimerId);
  avisoTimerId = setTimeout(() => el.aviso.classList.remove("visivel"), 8000);
}

function formatarData(iso) {
  const d = new Date(iso);
  return isNaN(d)
    ? String(iso || "")
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" }) +
        " " +
        d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

async function chamarApi(url, opcoes) {
  const resposta = await fetch(url, opcoes);
  if (resposta.status === 401) {
    location.href = "/login";
    throw new Error("sessão expirada");
  }
  const corpo = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(corpo.error || `erro ${resposta.status}`);
  return corpo;
}

// ---------- Relatório de importação ----------

const NOMES_TIPO = { cdr: "CDR do PABX", oportunidades: "Oportunidades (Omie)", mysql: "MySQL Unyflex", prospeccao: "Prospecção ativa (planilha)" };

// Relatório por aba da planilha de prospecção (uma linha por aba, com o que casou e o que não)
function blocoAbasProspeccao(abas) {
  if (!abas?.length) return "";
  const linhas = abas.map((a) => {
    if (a.motivo) {
      return `<tr class="sem-clique"><td class="celula-nome">${escapeHtml(a.aba)}</td><td colspan="7" class="relatorio-erro">não importada — ${escapeHtml(a.motivo)}</td></tr>`;
    }
    const cols = Object.entries(a.colunas || {}).map(([campo, rotulo]) => `${escapeHtml(campo)}←"${escapeHtml(rotulo)}"`).join(", ");
    const nao = (a.naoReconhecidas || []).map((r) => `<code>${escapeHtml(r)}</code>`).join(" ");
    const t = a.telefones || {};
    return `<tr class="sem-clique"><td class="celula-nome">${escapeHtml(a.aba)}${a.oculta ? ' <span class="chip">aba oculta</span>' : ""}</td>
      <td>${a.importadas}</td><td>${a.ocultas || 0}</td><td>${t.validos || 0} / ${t.invalidos || 0} / ${t.vazios || 0}</td>
      <td>${Object.keys(a.cores || {}).length}</td><td><strong>${a.novos ?? 0}</strong> / ${a.atualizados ?? 0} / ${a.identicos ?? 0}</td>
      <td style="text-align:left" class="texto-suave relatorio-colunas">${cols}</td>
      <td style="text-align:left">${nao || '<span class="texto-suave">—</span>'}</td></tr>`;
  }).join("");
  return `<h4>Abas (${abas.length})</h4><div class="tabela-scroll"><table class="tabela-metricas relatorio-abas">
    <thead><tr><th>Aba</th><th>Linhas</th><th>Ocultas</th><th>Tel. válidos / inválidos / vazios</th><th>Cores</th><th>Novos / atualiz. / idênticos</th>
    <th style="text-align:left">Colunas casadas</th><th style="text-align:left">Não reconhecidas (em extras)</th></tr></thead><tbody>${linhas}</tbody></table></div>`;
}

function blocoNaoReconhecidas(lista) {
  if (!lista?.length) return "";
  return `<h4>Colunas não reconhecidas no arquivo (preservadas em extras)</h4><ul>${lista
    .map((c) => `<li><code>${escapeHtml(c.rotulo)}</code> — ${c.abas.length} aba(s), ${c.linhas} valor(es): <span class="texto-suave">${c.abas.slice(0, 6).map(escapeHtml).join(", ")}${c.abas.length > 6 ? "…" : ""}</span></li>`)
    .join("")}</ul>`;
}

function blocoOcorrencias(titulo, grupo) {
  const chaves = Object.keys(grupo || {});
  if (!chaves.length) return "";
  const itens = chaves
    .map((motivo) => {
      const { qtde, amostras } = grupo[motivo];
      const exemplos = (amostras || [])
        .map((a) => `<li><code>${escapeHtml(a)}</code></li>`)
        .join("");
      return `<li><strong>${escapeHtml(motivo)}</strong>: ${qtde} linha(s)
        ${exemplos ? `<ul class="relatorio-amostras">${exemplos}</ul>` : ""}</li>`;
    })
    .join("");
  return `<h4>${escapeHtml(titulo)}</h4><ul>${itens}</ul>`;
}

function mostrarRelatorio(titulo, resultado) {
  const d = resultado.detalhes || {};
  const linhas = [];
  if (resultado.status === "erro") {
    linhas.push(`<p class="relatorio-erro">✕ ${escapeHtml(resultado.erro)}</p>`);
  } else if (resultado.tipo === "mysql") {
    linhas.push(
      `<p>✔ Snapshot copiado: <strong>${resultado.turmas}</strong> turma(s) e ` +
        `<strong>${resultado.matriculas}</strong> matrícula(s).</p>`
    );
  } else {
    const identicos =
      resultado.registrosIdenticos > 0 ? `, ${resultado.registrosIdenticos} idêntico(s)` : "";
    linhas.push(
      `<p>✔ ${resultado.linhasLidas} linha(s) lida(s), ${resultado.linhasValidas} válida(s), ` +
        `${resultado.linhasIgnoradas} ignorada(s) — ` +
        `<strong>${resultado.registrosNovos} novo(s)</strong>, ` +
        `${resultado.registrosAtualizados} atualizado(s)${identicos}.</p>`
    );
  }
  const periodo = resultado.periodo || d.periodo;
  if (periodo?.de) {
    linhas.push(
      `<p class="texto-suave">Período coberto pelo arquivo (Data de Inclusão): ` +
        `${escapeHtml(periodo.de)} a ${escapeHtml(periodo.ate)}.</p>`
    );
  }
  if (resultado.tipo === "prospeccao" || d.abas) {
    const m = d.municipios || {};
    linhas.push(
      `<p>Município casado: <strong>${m.casado || 0}</strong> · pendente: ${m.pendente || 0} · sem cidade: ${m.sem_cidade || 0}` +
        `${m.fora ? ` · fora da UF: ${m.fora}` : ""} — pendências na revisão de <a href="/territorio">/territorio</a>; ` +
        `cores em <a href="/prospeccao">/prospeccao</a>.</p>`
    );
    linhas.push(blocoAbasProspeccao(resultado.abas || d.abas));
    linhas.push(blocoNaoReconhecidas(d.colunasNaoReconhecidas));
  }
  linhas.push(blocoOcorrencias("Linhas ignoradas (por quê)", d.motivos));
  linhas.push(blocoOcorrencias("Linhas mantidas com ressalva", d.problemas));
  if (d.avisos?.length) {
    linhas.push(
      `<h4>Avisos</h4><ul>${d.avisos.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`
    );
  }
  el.relatorioTitulo.textContent = titulo;
  el.relatorioConteudo.innerHTML = linhas.join("");
  el.relatorio.classList.remove("oculto");
  el.relatorio.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------- Uploads ----------

// binario = true envia o arquivo como está (planilha .xlsx do Omie);
// caso contrário o conteúdo vai como texto (CSV do CDR).
async function enviarArquivo(input, rota, statusEl, rotulo, binario, queryExtra = "") {
  const arquivo = input.files?.[0];
  if (!arquivo) return;
  input.value = ""; // permite reenviar o mesmo arquivo
  statusEl.textContent = `jonIAs está importando "${arquivo.name}"…`;
  try {
    const corpo = binario ? await arquivo.arrayBuffer() : await arquivo.text();
    const tipo = binario ? "application/octet-stream" : "text/plain;charset=utf-8";
    const resultado = await chamarApi(
      `${rota}?arquivo=${encodeURIComponent(arquivo.name)}${queryExtra}`,
      { method: "POST", headers: { "Content-Type": tipo }, body: corpo }
    );
    statusEl.textContent =
      resultado.status === "erro"
        ? `Falha na importação de "${arquivo.name}".`
        : `Última importação: "${arquivo.name}" — ${resultado.registrosNovos} novo(s), ${resultado.registrosAtualizados} atualizado(s).`;
    mostrarRelatorio(`${rotulo} — ${arquivo.name}`, resultado);
  } catch (erro) {
    statusEl.textContent = `Falha na importação de "${arquivo.name}".`;
    mostrarAviso(`Não foi possível importar. (${erro.message})`);
  }
  carregarImportacoes();
}

el.arquivoCdr.addEventListener("change", () =>
  enviarArquivo(el.arquivoCdr, "/api/importacoes/cdr", el.cdrStatus, "CDR do PABX", false)
);
el.arquivoOportunidades.addEventListener("change", () =>
  enviarArquivo(
    el.arquivoOportunidades,
    "/api/importacoes/oportunidades",
    el.oportunidadesStatus,
    "Oportunidades (Omie)",
    true
  )
);
el.arquivoProspeccao?.addEventListener("change", () =>
  enviarArquivo(
    el.arquivoProspeccao,
    "/api/importacoes/prospeccao",
    el.prospeccaoStatus,
    `Prospecção ativa (${el.prospeccaoUf.value})`,
    true,
    `&uf=${encodeURIComponent(el.prospeccaoUf.value)}`
  )
);

// ---------- Sincronização MySQL ----------

async function carregarStatusMysql() {
  try {
    const s = await chamarApi("/api/sincronizacoes/status");
    if (!s.mysqlConfigurado) {
      el.mysqlStatus.textContent =
        "MySQL não configurado — defina MYSQL_* no .env do servidor para habilitar.";
      el.btnSincronizar.disabled = true;
      return;
    }
    el.btnSincronizar.disabled = false;
    if (s.ultimaSincronizacao) {
      const u = s.ultimaSincronizacao;
      el.mysqlStatus.textContent =
        u.status === "erro"
          ? `Última tentativa em ${formatarData(u.iniciado_em)} falhou.`
          : `Última sincronização: ${formatarData(u.concluido_em)} — ${s.turmas} turma(s), ${s.matriculas} matrícula(s) na cópia local.`;
    } else {
      el.mysqlStatus.textContent = "Nenhuma sincronização feita ainda.";
    }
  } catch (_) {
    el.mysqlStatus.textContent = "Não foi possível consultar o estado da sincronização.";
  }
}

el.btnSincronizar.addEventListener("click", async () => {
  el.btnSincronizar.disabled = true;
  el.mysqlStatus.textContent = "jonIAs está sincronizando com o MySQL…";
  try {
    const resultado = await chamarApi("/api/sincronizacoes/mysql", { method: "POST" });
    mostrarRelatorio("Sincronização MySQL", resultado);
  } catch (erro) {
    mostrarAviso(`Sincronização falhou. (${erro.message})`);
  }
  carregarStatusMysql();
  carregarImportacoes();
});

// ---------- Som do painel de TV (preferência global) ----------

function mostrarSomTv(ligado) {
  el.tvSomStatus.textContent = ligado
    ? "Som LIGADO — as TVs tocam o alerta de dado novo e a celebração de matrícula."
    : "Som DESLIGADO — as TVs avisam só pelo visual (pulso de borda e toast).";
  el.btnTvSom.textContent = ligado ? "🔕 Desligar som das TVs" : "🔔 Ligar som das TVs";
  el.btnTvSom.dataset.ligado = ligado ? "1" : "0";
  el.btnTvSom.disabled = false;
}

async function carregarSomTv() {
  try {
    const { som } = await chamarApi("/api/config/tv");
    mostrarSomTv(som);
  } catch (_) {
    el.tvSomStatus.textContent = "Não foi possível consultar a configuração de som.";
  }
}

el.btnTvSom.addEventListener("click", async () => {
  const novo = el.btnTvSom.dataset.ligado !== "1";
  el.btnTvSom.disabled = true;
  try {
    const { som } = await chamarApi("/api/config/tv", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ som: novo }),
    });
    mostrarSomTv(som);
  } catch (erro) {
    el.btnTvSom.disabled = false;
    mostrarAviso(`Não foi possível alterar o som das TVs. (${erro.message})`);
  }
});

// ---------- Histórico ----------

function chipStatus(imp) {
  return imp.status === "erro"
    ? '<span class="chip chip-encerrada">erro</span>'
    : '<span class="chip chip-andamento">concluída</span>';
}

async function carregarImportacoes() {
  try {
    const { importacoes } = await chamarApi("/api/importacoes");
    el.vazio.classList.toggle("oculto", importacoes.length > 0);
    el.lista.innerHTML = "";
    for (const imp of importacoes) {
      const item = document.createElement("div");
      item.className = "aula-item";
      const resumo =
        imp.status === "erro"
          ? escapeHtml(imp.erro || "erro")
          : `${imp.linhas_lidas} lida(s) · ${imp.linhas_ignoradas} ignorada(s) · ` +
            `${imp.registros_novos} novo(s) · ${imp.registros_atualizados} atualizado(s)` +
            (imp.registros_identicos > 0 ? ` · ${imp.registros_identicos} idêntico(s)` : "");
      item.innerHTML = `
        <div class="aula-info">
          <div class="aula-nome-linha">
            <span class="aula-nome">#${imp.id} — ${escapeHtml(NOMES_TIPO[imp.tipo] || imp.tipo)}</span>
            ${chipStatus(imp)}
          </div>
          <div class="aula-meta">
            ${imp.arquivo_nome ? `<span>📄 ${escapeHtml(imp.arquivo_nome)}</span>` : ""}
            <span>🕒 ${formatarData(imp.iniciado_em)}</span>
            <span>👤 ${escapeHtml(imp.usuario)}</span>
            <span>${resumo}</span>
          </div>
        </div>
        <div class="aula-acoes">
          <button class="btn btn-secundario btn-mini" data-acao="detalhes">Detalhes</button>
        </div>`;
      item.querySelector('[data-acao="detalhes"]').addEventListener("click", async () => {
        try {
          const det = await chamarApi(`/api/importacoes/${imp.id}`);
          mostrarRelatorio(
            `Importação #${det.id} — ${NOMES_TIPO[det.tipo] || det.tipo}`,
            {
              status: det.status,
              erro: det.erro,
              tipo: det.tipo,
              turmas: "-",
              matriculas: "-",
              linhasLidas: det.linhas_lidas,
              linhasValidas: det.linhas_validas,
              linhasIgnoradas: det.linhas_ignoradas,
              registrosNovos: det.registros_novos,
              registrosAtualizados: det.registros_atualizados,
              registrosIdenticos: det.registros_identicos,
              detalhes: det.detalhes,
            }
          );
        } catch (erro) {
          mostrarAviso(`Não foi possível abrir os detalhes. (${erro.message})`);
        }
      });
      el.lista.appendChild(item);
    }
  } catch (erro) {
    mostrarAviso(`Não foi possível listar as ingestões. (${erro.message})`);
  }
}

// ---------- Inicialização ----------

el.btnFecharRelatorio.addEventListener("click", () => el.relatorio.classList.add("oculto"));
el.btnSair.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" }).catch(() => {});
  location.href = "/login";
});

carregarStatusMysql();
carregarImportacoes();
carregarSomTv();

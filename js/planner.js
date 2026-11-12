"use strict";

// /marketing → aba Planner de conteúdo (migração 41; planner.js no servidor).
// Migra o artifact "Funil de Conteúdo Unyflex": calendário mensal com formas
// (formato) e cores (etapa do funil), planejado → produzido → publicado,
// métricas, feito extra, rotina semanal, fechamento de sexta, padrão de
// captação e desempenho por formato. NOVO: link obrigatório ao publicar e no
// extra, carimbo de cada estado e ATRASO (dias corridos da data do post ao
// carimbo de publicado). Usa os auxiliares globais de js/marketing.js
// (escapeHtml, chamarApi, json, avisar, dataBr, ddmm, diaSemana, dataHoraBr,
// plural, decimal, card, estado).

(() => {
  const ETAPAS = { "Descobrir": "descobrir", "Confiar": "confiar", "Conversar": "conversar", "Fechamento": "fechamento", "Voltar a comprar": "voltar", "Reaproveitamento": "reap", "Livre (Kesley)": "livre" };
  const SHAPES = [["circulo", "Reels / vídeo"], ["quadrado", "Post"], ["triangulo", "Story / status"], ["hexagono", "Grupo"]];
  const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
  const FORMATOS_EXTRA = ["Story", "Reels / vídeo", "Carrossel", "Card", "Resposta / comentário", "Gravação", "Arte avulsa", "Outro"];
  const CANAIS_EXTRA = ["Instagram", "Instagram Stories", "LinkedIn", "YouTube", "Grupos de WhatsApp", "Status do WhatsApp", "Outro"];
  // Cronograma semanal do Bruno (rotina da Kesley) — texto do planner original
  const ROTINA = [
    { d: "Segunda", foco: "Planejamento + produção + gravações", ent: "pauta semanal organizada, conteúdos preparados e gravações/fotos de eventos encaminhadas", itens: ["Alinhamento semanal: apresentar/conferir o calendário editorial e revisar prioridades", "Conferir cursos, turmas, horários, locais e professores da semana", "Definir pauta e lista de captação por curso (fotos, vídeos, falas, depoimentos, chamadas)", "Gravações programadas com professores, equipe ou participantes", "Coffee break de eventos: fotografar participantes, professores, networking e estrutura", "Registrar fotos e vídeos em vertical e horizontal quando possível", "Produzir 2 posts de cursos/produtos e preparar a gaveta de WhatsApp", "Ajustar peças pendentes, preparar aprovados e responder mensagens", "Conferir fontes e modelos salvos no CapCut"] },
    { d: "Terça", foco: "Início da cobertura presencial", ent: "Stories atualizados, fotos organizadas e vídeos nos formatos de cada canal", itens: ["Registrar chegada dos participantes, sala preparada e abertura da turma", "Entrar nas salas nos momentos adequados, sem atrapalhar a aula", "Fotografar professores, alunos, interações, materiais e detalhes", "Gravar vertical (9:16) para Stories/Reels e horizontal (16:9) quando possível", "Publicar Stories em tempo real (pauta e autorização de imagem)", "Registrar coffee break, networking e bastidores", "Combinar com professores falas técnicas, depoimentos e chamadas", "Captar conteúdo para Reels, Shorts e anúncios", "Separar arquivos por curso e data"] },
    { d: "Quarta", foco: "Cobertura + conteúdo com professores", ent: "material técnico, depoimentos, banco de imagens atualizado e prioritários em edição", itens: ["Registrar aulas, professores e alunos em momentos oportunos", "Fotos verticais e horizontais: plano geral, médio e detalhes", "Vídeos curtos verticais para Stories e para editar em Reels", "Versões horizontais de falas para YouTube e uso institucional", "Gravar falas técnicas dos professores nos intervalos", "Gravar dicas práticas, erros comuns e aplicações no município", "Depoimentos de alunos voluntários, com autorização de imagem e voz", "Fotografar professores para o banco de imagens; networking e coffee", "Selecionar materiais e iniciar a edição dos prioritários"] },
    { d: "Quinta", foco: "Cobertura + edição + distribuição", ent: "conteúdos editados, publicações do calendário feitas e materiais enviados para aprovação", itens: ["Registrar aulas, professores, alunos, coffee break e bastidores", "Fotos e vídeos verticais e horizontais conforme o uso", "Publicar Stories em tempo real quando relevante e autorizado", "Captar falas pendentes e confirmar nomes, cargos, curso e contexto", "Editar Reels, Shorts e depoimentos; preparar carrosséis", "Usar fontes e modelos do CapCut; identidade visual aprovada", "Revisar áudio, cortes, legendas, ortografia, nomes e datas", "Publicar o previsto no calendário; alimentar LinkedIn e YouTube", "Atualizar Google Meu Negócio, responder avaliações, conferir aprovações"] },
    { d: "Sexta", foco: "Cobertura da manhã + fechamento", ent: "cobertura concluída, arquivos organizados, pendências registradas e próxima semana encaminhada", itens: ["Registrar as últimas aulas e momentos relevantes da manhã", "Fotografar professores e alunos; depoimentos de encerramento", "Fotos e vídeos verticais e horizontais sempre que possível", "Publicar Stories em tempo real durante a cobertura", "Selecionar as melhores fotos e vídeos da semana", "Organizar arquivos por curso, data e tipo; nomear com clareza", "Preparar álbum, carrossel ou compilado semanal", "Conferir publicados, pendentes e motivos (tabela de fechamento)", "Definir a próxima ação de cada pendência e encaminhar a segunda"] },
  ];
  // Padrão de captação e checklist antes de encerrar — texto do planner original
  const REF = ["Vertical (9:16) para Stories e Reels; horizontal (16:9) para YouTube, entrevistas e institucional", "Quando der, a mesma cena nos dois formatos, sem depender de recorte", "Lente limpa, luz, estabilidade e áudio; sem rostos cortados ou imagem tremida", "Stories: conferir nome do curso, professor e município antes de publicar", "Respeitar autorizações de imagem e voz; nada de dados pessoais ou material restrito", "Falas: local silencioso e iluminado, celular na altura dos olhos, alguns segundos antes e depois", "Perguntas: principal aprendizado · como aplicar no município · erro comum a evitar", "Arquivos: data_Curso_Tema_Formato (ex.: 2026-10-22_Curso_Tema_Reels)", "Antes de encerrar: imagem nos 2 formatos · Stories publicados · áudio e luz · autorização · organização · edição revisada"];

  const pl = { d: null, visao: "calendario", mes: null, semana: null, filtros: { curso: "", canal: "", etapa: "" }, editandoVinculo: null, relatorio: null };

  // ---------- utilitários de data (strings AAAA-MM-DD, sem fuso) ----------
  const somar = (d, n) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const segunda = (d) => { const w = new Date(`${d}T12:00:00Z`).getUTCDay(); return somar(d, -((w + 6) % 7)); };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const fmtN = (n) => (n >= 1000 ? (n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : String(n));
  const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

  // ---------- formas e cores (as do planner) ----------
  function forma(p) {
    const c = norm(p.canal), f = norm(p.formato);
    if (c.includes("e-mail") || c.includes("email")) return "losango";
    if (c.includes("grupo")) return "hexagono";
    if (c.includes("status") || c.includes("stories") || f.startsWith("story") || f.includes("stories")) return "triangulo";
    if (c.includes("reels") || c.includes("short") || f.includes("reels") || f.includes("short") || f.includes("video")) return "circulo";
    return "quadrado";
  }
  const corEtapa = (e) => `var(--pl-${ETAPAS[e] || "reap"})`;
  function svg(kind, cor, s = 22) {
    const P = {
      circulo: `<circle cx="12" cy="12" r="10.5" fill="${cor}"/>`, quadrado: `<rect x="2" y="2" width="20" height="20" rx="3" fill="${cor}"/>`,
      triangulo: `<path d="M12 2.2 22.6 21H1.4Z" fill="${cor}" stroke="${cor}" stroke-width="1.5" stroke-linejoin="round"/>`,
      losango: `<path d="M12 1.2 22.8 12 12 22.8 1.2 12Z" fill="${cor}"/>`, hexagono: `<path d="M6.3 2.5h11.4l5.6 9.5-5.6 9.5H6.3L.7 12Z" fill="${cor}"/>`,
    };
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${P[kind]}</svg>`;
  }
  function svgExtra(kind, s = 22) {
    const st = `fill="none" stroke="var(--texto)" stroke-width="1.8" stroke-dasharray="3 2.2" stroke-linejoin="round"`;
    const P = { circulo: `<circle cx="12" cy="12" r="9.8" ${st}/>`, quadrado: `<rect x="3" y="3" width="18" height="18" rx="3" ${st}/>`, triangulo: `<path d="M12 3 21.5 20.5H2.5Z" ${st}/>` };
    return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${P[kind] || P.quadrado}</svg>`;
  }
  const formaExtra = (x) => { const f = norm(x.formato); return f.startsWith("story") ? "triangulo" : (f.includes("reels") || f.startsWith("gravacao")) ? "circulo" : "quadrado"; };

  // ---------- selos ----------
  function seloPost(p) {
    if (p.foraDoPlano) return `<span class="mk-selo mk-retro">saiu do plano</span>`;
    if (p.situacao === "publicado") {
      if (p.migrado || !p.publicadoEm) return `<span class="mk-selo mk-retro">publicado · migrado, sem carimbo</span>`;
      if (p.retroativo) return `<span class="mk-selo mk-retro">publicado · retroativo</span>`;
      return p.atrasoDias > 0 ? `<span class="mk-selo mk-atraso">publicado com ${plural(p.atrasoDias, "dia", "dias")} de atraso</span>` : `<span class="mk-selo mk-ok">✓ publicado no dia</span>`;
    }
    if (p.situacao === "nao_vai_sair") return `<span class="mk-selo mk-atraso">não vai sair</span>`;
    const prod = p.estado === "produzido" ? " · produzido" : "";
    if (p.retroativo) return `<span class="mk-selo mk-retro">${p.situacao === "no_prazo" ? "planejado" : "pendente"}${prod} · retroativo</span>`;
    if (p.situacao === "atrasado") return `<span class="mk-selo mk-atraso">${plural(p.atrasoDias, "dia", "dias")} de atraso${prod}</span>`;
    if (p.situacao === "hoje") return `<span class="mk-selo mk-hoje">é hoje${prod}</span>`;
    return `<span class="mk-selo mk-prazo">${p.estado === "produzido" ? "produzido · " : ""}${diaSemana(p.data)} ${ddmm(p.data)}</span>`;
  }
  const NOME_RESP = { kesley: "Kesley", gustavo: "Gustavo" };
  function vinculoTexto(p) {
    if (p.vinculo === "turmas") return p.turmas.map((t) => `${escapeHtml(t.nome)} (${ddmm(t.inicio)})`).join(" · ");
    if (p.vinculo === "setor") return `Setor: ${escapeHtml(p.setor || "")}`;
    if (p.vinculo === "institucional") return "Institucional (sem turma)";
    if (p.vinculo === "livre") return "Livre (sem turma)";
    return `<span class="pl-pendente">sem turma ligada — "${escapeHtml(p.cursoTexto || "")}"</span>`;
  }

  // ---------- KPIs da semana (topo) ----------
  function renderKpis() {
    const d = pl.d;
    const k = d.indicadores.semana.kesley, g = d.indicadores.semana.gustavo;
    const seg = segunda(d.hoje), dom = somar(seg, 6);
    const daSemana = (o) => o.data >= seg && o.data <= dom;
    const posts = d.posts.filter((p) => daSemana(p) && !p.foraDoPlano);
    const extras = d.extras.filter(daSemana);
    const conv = posts.reduce((a, p) => a + num(p.conversas), 0) + extras.reduce((a, x) => a + num(x.conversas), 0);
    const alc = posts.reduce((a, p) => a + num(p.alcance), 0) + extras.reduce((a, x) => a + num(x.alcance), 0);
    const pub = posts.filter((p) => p.situacao === "publicado").length;
    const pct = (x) => (x.pctNoPrazo === null ? "—" : `${x.pctNoPrazo}%`);
    const linhaInd = (x) => x.devidos
      ? `${x.noPrazo} de ${x.devidos} devidos no prazo · atraso médio ${x.atrasoMedio === null ? "—" : `${decimal(x.atrasoMedio)} d`}${x.naoVaiSair ? ` · ${x.naoVaiSair} não vai sair` : ""}`
      : `nenhum post vencido ainda (${x.planejados} na semana)`;
    document.getElementById("pl-kpis").innerHTML = [
      card("Kesley · no prazo (semana)", pct(k), linhaInd(k), k.pctNoPrazo === null ? "" : k.pctNoPrazo >= 100 ? "mk-card-verde" : k.atrasados ? "mk-card-vermelho" : "mk-card-amarelo"),
      card("Kesley · atrasados agora", k.atrasados, k.atrasados ? `maior atraso: ${plural(k.maiorAtraso, "dia", "dias")}` : "nenhum ✓", k.atrasados ? "mk-card-vermelho" : "mk-card-verde"),
      card("Conversas da semana", `${conv}<small> / ${d.metaConversas}</small>`, conv >= d.metaConversas ? "✓ meta batida" : `faltam ${d.metaConversas - conv} para a meta`, conv >= d.metaConversas ? "mk-card-verde" : ""),
      card("Publicados na semana", `${pub}<small> de ${posts.length}</small>`, `${extras.length ? `+${extras.length} extra(s) · ` : ""}alcance ${fmtN(alc)}`),
      card("Gustavo · Status do WhatsApp", pct(g), g.planejados ? linhaInd(g) : "sem post dele nesta semana", g.atrasados ? "mk-card-vermelho" : ""),
    ].join("");
    const atrasadosTotal = d.posts.filter((p) => p.situacao === "atrasado" && !p.retroativo && !p.foraDoPlano).length;
    document.getElementById("alerta-planner").textContent = atrasadosTotal || "";
    document.getElementById("pl-alerta-vinculos").textContent = estado.admin && d.vinculos.pendentes.length ? d.vinculos.pendentes.reduce((a, v) => a + v.posts, 0) : "";
  }

  // ---------- calendário ----------
  const filtrado = (p) => {
    const f = pl.filtros;
    return (!f.curso || p.cursoTexto === f.curso) && (!f.canal || p.canal === f.canal) && (!f.etapa || p.etapa === f.etapa);
  };
  const meses = () => [...new Set([...pl.d.posts.map((p) => p.data.slice(0, 7)), pl.d.hoje.slice(0, 7)])].sort();
  const opcoes = (vals, rotulo, atual) => `<option value="">${rotulo}</option>` + vals.map((v) => `<option ${v === atual ? "selected" : ""}>${escapeHtml(v)}</option>`).join("");

  function anel(v, meta) {
    const r = 24, c = 2 * Math.PI * r, p = meta ? Math.min(1, v / meta) : 0, cor = v >= meta ? "var(--verde)" : "var(--pl-conversar)";
    return `<div class="pl-anel" title="conversas da semana × meta ${meta}"><svg viewBox="0 0 58 58"><circle cx="29" cy="29" r="${r}" fill="none" stroke="var(--borda-painel)" stroke-width="6"/>${p > 0 ? `<circle cx="29" cy="29" r="${r}" fill="none" stroke="${cor}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 29 29)"/>` : ""}</svg><b>${v}<small>/${meta}</small></b></div>`;
  }

  function renderCalendario() {
    const d = pl.d, ms = meses();
    if (!pl.mes || !ms.includes(pl.mes)) pl.mes = ms.includes(d.hoje.slice(0, 7)) ? d.hoje.slice(0, 7) : ms[0];
    const [y, m] = pl.mes.split("-").map(Number);
    const posts = d.posts.filter((p) => !p.foraDoPlano);
    const fer = Object.fromEntries(d.feriados.map((f) => [f.data, f.nome]));
    const semFiltroDeCurso = !pl.filtros.curso && !pl.filtros.etapa;
    const legenda = SHAPES.map(([k, l]) => `<i>${svg(k, "var(--texto-suave)", 13)}${l}</i>`).join("") + `<span class="pl-sep"></span>` +
      Object.keys(ETAPAS).map((e) => `<i><svg width="10" height="10"><circle cx="5" cy="5" r="5" fill="${corEtapa(e)}"/></svg>${e}</i>`).join("") + `<span class="pl-sep"></span>` +
      `<i><span class="pl-ponto" data-s="produzido"></span>Produzido</i><i><span class="pl-ponto" data-s="publicado"></span>Publicado</i><i><span class="pl-ponto pl-ponto-atraso"></span>Atrasado</i><i>${svgExtra("quadrado", 13)}Feito extra</i>`;
    const ultimo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    let dia = segunda(`${pl.mes}-01`);
    let grade = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"].map((x) => `<div class="pl-hd">${x}</div>`).join("") + `<div class="pl-hd">Conversas</div>`;
    while (dia <= ultimo) {
      const inicio = dia;
      for (let i = 0; i < 7; i++) {
        const noMes = dia.slice(0, 7) === pl.mes;
        const dp = posts.filter((p) => p.data === dia).sort((a, b) => (a.etapa || "").localeCompare(b.etapa || ""));
        const dx = d.extras.filter((x) => x.data === dia);
        const formas = dp.map((p) => {
          const on = filtrado(p);
          const ponto = p.estado === "produzido" || p.estado === "publicado" ? `<span class="pl-ponto" data-s="${p.estado}"></span>` : p.situacao === "atrasado" && !p.retroativo ? `<span class="pl-ponto pl-ponto-atraso"></span>` : "";
          return `<button type="button" class="pl-forma${on ? "" : " pl-dim"}${p.situacao === "nao_vai_sair" ? " pl-nao-sai" : ""}" data-post="${p.id}" title="${escapeHtml(`${p.gancho || p.cursoTexto} — ${p.canal} · ${p.etapa}`)}">${svg(forma(p), corEtapa(p.etapa))}${ponto}</button>`;
        }).join("") + dx.map((x) => `<button type="button" class="pl-forma${semFiltroDeCurso && (!pl.filtros.canal || pl.filtros.canal === x.canal) ? "" : " pl-dim"}" data-extra="${x.id}" title="${escapeHtml("Extra · " + x.titulo)}">${svgExtra(formaExtra(x))}</button>`).join("");
        grade += `<div class="pl-dia${noMes ? "" : " pl-fora"}${i >= 5 ? " pl-fds" : ""}${dia === d.hoje ? " pl-hoje" : ""}"><div class="pl-dtop"><span>${Number(dia.slice(8))}</span>${noMes && fer[dia] ? `<em>${escapeHtml(fer[dia])}</em>` : ""}</div><div class="pl-formas">${formas}</div></div>`;
        dia = somar(dia, 1);
      }
      const fim = somar(inicio, 6);
      const wp = posts.filter((p) => p.data >= inicio && p.data <= fim && filtrado(p));
      const wx = d.extras.filter((x) => x.data >= inicio && x.data <= fim);
      const conv = wp.reduce((a, p) => a + num(p.conversas), 0) + wx.reduce((a, x) => a + num(x.conversas), 0);
      grade += wp.length || wx.length ? `<div class="pl-meta">${anel(conv, d.metaConversas)}<span>${wp.filter((p) => p.situacao === "publicado").length}/${wp.length} no ar${wx.length ? ` · +${wx.length} extra(s)` : ""}</span></div>` : `<div class="pl-meta"></div>`;
    }
    const i = ms.indexOf(pl.mes);
    return `<div class="mk-controles pl-barra">
        <button type="button" class="btn-mini" data-pl-mes="-1" ${i <= 0 ? "disabled" : ""}>‹</button>
        <strong class="pl-mes-titulo">${MESES[m - 1]} ${y}</strong>
        <button type="button" class="btn-mini" data-pl-mes="1" ${i >= ms.length - 1 ? "disabled" : ""}>›</button>
        <button type="button" class="btn-mini" data-pl-mes="hoje">hoje</button>
        <select class="campo-select" data-pl-filtro="curso">${opcoes([...new Set(posts.map((p) => p.cursoTexto).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt")), "Curso/turma", pl.filtros.curso)}</select>
        <select class="campo-select" data-pl-filtro="canal">${opcoes([...new Set(posts.map((p) => p.canal).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt")), "Canal", pl.filtros.canal)}</select>
        <select class="campo-select" data-pl-filtro="etapa">${opcoes(Object.keys(ETAPAS).filter((e) => posts.some((p) => p.etapa === e)), "Etapa", pl.filtros.etapa)}</select>
        <button type="button" class="btn-mini btn-primario" data-pl-extra="novo">+ feito extra</button>
      </div>
      <div class="pl-legenda">${legenda}</div>
      <div class="pl-cal">${grade}</div>
      <p class="texto-suave pl-fontes">${d.fontes.length ? "Fonte: " + d.fontes.map((f) => `${escapeHtml(f.fonte)} (${f.n} posts)`).join(" · ") : "Nenhuma planilha importada ainda."}</p>`;
  }

  // ---------- rotina e fechamento ----------
  function renderSemana() {
    const d = pl.d;
    if (!pl.semana) pl.semana = segunda(d.hoje);
    const checks = d.rotina[pl.semana] || {};
    const fer = Object.fromEntries(d.feriados.map((f) => [f.data, f.nome]));
    let total = 0, feitos = 0;
    const dias = ROTINA.map((r, di) => {
      const dia = somar(pl.semana, di);
      const dp = d.posts.filter((p) => p.data === dia && !p.foraDoPlano);
      const pub = dp.length ? dp.map((p) => `<button type="button" class="pl-item-post" data-post="${p.id}">${svg(forma(p), corEtapa(p.etapa), 14)}<span>${escapeHtml(p.gancho || p.cursoTexto)}<em>${escapeHtml(p.canal)}</em> ${seloPost(p)}</span></button>`).join("")
        : `<span class="texto-suave">${fer[dia] ? `${escapeHtml(fer[dia])}: sem post` : "Nada no planner"}</span>`;
      const itens = r.itens.map((t, ii) => {
        total++;
        const k = `d${di}i${ii}`, c = checks[k];
        if (c) feitos++;
        return `<label title="${c ? escapeHtml(`marcado em ${dataHoraBr(c.em)}${c.por ? ` · ${c.por}` : ""}`) : ""}"><input type="checkbox" data-pl-rotina="${k}" ${c ? "checked" : ""} /><span>${escapeHtml(t)}</span></label>`;
      }).join("");
      return `<article class="pl-dia-rotina${dia === d.hoje ? " pl-hoje" : ""}"><h3>${r.d} <span>${ddmm(dia)}</span></h3><p class="pl-foco">${escapeHtml(r.foco)}</p>
        <div class="pl-rotulo">Publicar (planner)</div><div class="pl-lista-posts">${pub}</div>
        <div class="pl-rotulo">Rotina</div><div class="pl-checks">${itens}</div><div class="pl-entrega"><b>Entrega:</b> ${escapeHtml(r.ent)}</div></article>`;
    }).join("");
    const pct = total ? Math.round((feitos / total) * 100) : 0;
    const fim = somar(pl.semana, 6);
    const wp = d.posts.filter((p) => p.data >= pl.semana && p.data <= fim && !p.foraDoPlano).sort((a, b) => a.data.localeCompare(b.data));
    const fechamento = wp.length ? wp.map((p) => {
      const pend = p.situacao !== "publicado";
      return `<tr class="sem-clique mk-l-${p.retroativo ? "retro" : p.situacao}"><td>${diaSemana(p.data)} ${ddmm(p.data)}</td><td style="text-align:left">${escapeHtml(p.canal)}</td>
        <td style="text-align:left"><button type="button" class="btn-mini mk-link" data-post="${p.id}">${escapeHtml(p.gancho || p.cursoTexto)}</button></td><td style="text-align:left">${seloPost(p)}</td>
        <td style="text-align:left">${pend ? `<input class="campo-select" data-pl-fech="motivo" data-id="${p.id}" value="${escapeHtml(p.motivo || "")}" placeholder="Por que não saiu" maxlength="300" />` : ""}</td>
        <td style="text-align:left">${pend ? `<input class="campo-select" data-pl-fech="proxima" data-id="${p.id}" value="${escapeHtml(p.proxima || "")}" placeholder="O que fazer e quando" maxlength="300" />` : ""}</td></tr>`;
    }).join("") : `<tr class="sem-clique"><td colspan="6" class="texto-suave">Nenhum post do planner nesta semana.</td></tr>`;
    return `<div class="mk-controles pl-barra">
        <button type="button" class="btn-mini" data-pl-semana="-7">‹</button><strong>Semana de ${dataBr(pl.semana)} a ${dataBr(somar(pl.semana, 4))}</strong>
        <button type="button" class="btn-mini" data-pl-semana="7">›</button><button type="button" class="btn-mini" data-pl-semana="hoje">esta semana</button>
        <span class="pl-progresso"><span style="width:${pct}%"></span></span><span>${feitos}/${total} · ${pct}%</span>
      </div>
      <div class="pl-dias">${dias}</div>
      <h3 class="secao-titulo">Fechamento de sexta — o que ficou pendente, por quê e a próxima ação</h3>
      <p class="texto-suave">Quando o atraso vier do design (ou de qualquer insumo), registre aqui no motivo.</p>
      <div class="tabela-scroll"><table class="tabela-metricas mk-tabela pl-fechamento"><thead><tr><th>Dia</th><th style="text-align:left">Canal</th><th style="text-align:left">Post</th><th style="text-align:left">Situação</th><th style="text-align:left">Motivo</th><th style="text-align:left">Próxima ação</th></tr></thead><tbody>${fechamento}</tbody></table></div>
      <h3 class="secao-titulo">Padrão de captação e checklist antes de encerrar</h3>
      <ul class="pl-ref">${REF.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
  }

  // ---------- desempenho por formato ----------
  const CATS = ["Reels / vídeo", "Carrossel", "Card", "Story", "Outros"];
  function catExtra(x) { const f = norm(x.formato); if (f.startsWith("story")) return "Story"; if (f.includes("reels")) return "Reels / vídeo"; if (f.startsWith("carrossel")) return "Carrossel"; if (f.startsWith("card")) return "Card"; return "Outros"; }
  function catPost(p) {
    const f = norm(p.formato), c = norm(p.canal);
    if (!(c.includes("instagram") || c.includes("linkedin") || c.includes("youtube"))) return null;
    if (c.includes("stories") || f.includes("stories") || f.startsWith("story")) return "Story";
    if (f.includes("reels") || f.includes("short") || f.includes("video") || c.includes("reels") || c.includes("short")) return "Reels / vídeo";
    if (f.includes("carrossel") || f.includes("documento") || c.includes("carrossel")) return "Carrossel";
    if (f.includes("card") || f.includes("post") || f.includes("foto")) return "Card";
    return null;
  }
  function renderDesempenho() {
    const g = {};
    const add = (k, o, a, e, c) => { const x = (g[`${k}|${o}`] ||= { n: 0, m: 0, a: 0, e: 0, c: 0 }); x.n++; x.c += c; if (a > 0) { x.m++; x.a += a; x.e += e; } };
    const pubs = pl.d.posts.filter((p) => p.situacao === "publicado" && catPost(p));
    pubs.forEach((p) => add(catPost(p), "Planejado", num(p.alcance), num(p.engajamento), num(p.conversas)));
    pl.d.extras.forEach((x) => add(catExtra(x), "Extra", num(x.alcance), num(x.engajamento), num(x.conversas)));
    const linhas = [];
    CATS.forEach((k) => ["Planejado", "Extra"].forEach((o) => {
      const x = g[`${k}|${o}`];
      if (!x && (o === "Extra" || k === "Outros")) return;
      if (!x) { linhas.push(`<tr class="sem-clique"><td style="text-align:left">${k}</td><td style="text-align:left">${o}</td><td>0</td><td>–</td><td>–</td><td>–</td><td>–</td></tr>`); return; }
      const poucos = x.n < 5 ? ` <span class="mk-selo mk-prazo">poucos dados</span>` : "";
      const media = (v) => (x.m ? fmtN(Math.round(v / x.m)) : "–");
      linhas.push(`<tr class="sem-clique"><td style="text-align:left">${k}${poucos}</td><td style="text-align:left">${o}</td><td>${x.n}</td><td>${media(x.a)}</td><td>${media(x.e)}</td><td>${x.a ? `${(x.e / x.a * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "–"}</td><td>${x.c}</td></tr>`);
    }));
    linhas.push(`<tr class="sem-clique"><td style="text-align:left"><b>Total</b></td><td style="text-align:left">Planejado + extra</td><td>${pubs.length} + ${pl.d.extras.length}</td><td></td><td></td><td></td><td></td></tr>`);
    return `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela"><thead><tr><th style="text-align:left">Formato</th><th style="text-align:left">Origem</th><th>Feitos</th><th>Alcance médio</th><th>Engajamento médio</th><th>Taxa</th><th>Conversas</th></tr></thead><tbody>${linhas.join("")}</tbody></table></div>
      <p class="texto-suave">Planejado = posts do planner marcados como publicados (Instagram, LinkedIn e YouTube). Extra = feitos além do planejado. Médias só com alcance registrado. Engajamento = curtidas + comentários + salvamentos + compartilhamentos. Taxa = engajamento ÷ alcance. Com menos de 5 posts, o formato aparece como "poucos dados".</p>`;
  }

  // ---------- turmas dos posts (admin) ----------
  function formVinculo(texto) {
    const atual = pl.d.vinculos.manuais.find((v) => v.texto === texto);
    const post = pl.d.posts.find((p) => p.cursoTexto === texto);
    const marcadas = new Set(atual ? atual.turmas : (post?.turmas || []).map((t) => t.id));
    const tipo = atual?.vinculo || (post && post.vinculo !== "pendente" ? post.vinculo : "turmas");
    return `<div class="pl-vinculo-form" data-texto="${escapeHtml(texto)}">
      <div class="mk-controles">${["turmas", "institucional", "setor", "livre"].map((t) => `<label><input type="radio" name="pl-vtipo" value="${t}" ${t === tipo ? "checked" : ""}/> ${t === "turmas" ? "turma(s) do banco" : t}</label>`).join("")}</div>
      <input type="text" class="campo-select" name="pl-vsetor" placeholder="setor (ex.: Licitações)" value="${escapeHtml(atual?.setor || post?.setor || "")}" />
      <input type="search" class="campo-select" name="pl-vbusca" placeholder="filtrar turmas…" />
      <div class="pl-turmas-lista">${turmasOrdenadas().map((t) => `<label data-busca="${escapeHtml(norm(`${t.nome} ${t.subtitulo} ${dataBr(t.inicio)}`))}"><input type="checkbox" value="${t.id}" ${marcadas.has(t.id) ? "checked" : ""}/> ${dataBr(t.inicio)} — ${escapeHtml(t.nome)}${t.subtitulo ? ` <small class="texto-suave">${escapeHtml(t.subtitulo)}</small>` : ""}</label>`).join("")}</div>
      <div class="mk-controles"><button type="button" class="btn-mini btn-primario" data-pl-vsalvar>Salvar para todos os posts com esse texto</button><button type="button" class="btn-mini" data-pl-vcancelar>cancelar</button></div>
    </div>`;
  }
  // Turmas futuras primeiro (da mais próxima à mais distante), depois as passadas (da mais recente)
  function turmasOrdenadas() {
    const hoje = pl.d.hoje;
    return [...pl.d.turmasParaVinculo].sort((a, b) => {
      const pa = a.inicio < hoje, pb = b.inicio < hoje;
      if (pa !== pb) return pa ? 1 : -1;
      return pa ? b.inicio.localeCompare(a.inicio) : a.inicio.localeCompare(b.inicio);
    });
  }
  function renderVinculos() {
    if (!estado.admin) return `<p class="texto-suave">Só o administrador liga posts a turmas.</p>`;
    const d = pl.d;
    const autos = new Map();
    for (const p of d.posts) {
      if (p.foraDoPlano || p.vinculo !== "turmas" || !p.turmas.length || p.turmas.some((t) => t.metodo === "manual")) continue;
      if (!autos.has(p.cursoTexto)) autos.set(p.cursoTexto, { texto: p.cursoTexto, posts: 0, turmas: p.turmas });
      autos.get(p.cursoTexto).posts++;
    }
    const linha = (texto, extra, botao) => `<tr class="sem-clique"><td style="text-align:left"><b>${escapeHtml(texto || "(vazio)")}</b></td><td style="text-align:left">${extra}</td>
      <td style="text-align:left">${pl.editandoVinculo === texto ? "" : `<button type="button" class="btn-mini" data-pl-vabrir="${escapeHtml(texto)}">${botao}</button>`}</td></tr>` +
      (pl.editandoVinculo === texto ? `<tr class="sem-clique"><td colspan="3" style="text-align:left">${formVinculo(texto)}</td></tr>` : "");
    const cab = (c2) => `<thead><tr><th style="text-align:left">Texto na planilha (curso/turma)</th><th style="text-align:left">${c2}</th><th></th></tr></thead>`;
    return `<p class="texto-suave">O importador liga o post à turma pela DATA de início citada no texto e por uma palavra em comum no nome. O que não casou fica aqui. A escolha vale para todos os posts com o mesmo texto e é reaplicada a cada importação.</p>
      <h3 class="secao-titulo">Sem turma ligada (${d.vinculos.pendentes.length})</h3>
      ${d.vinculos.pendentes.length ? `<div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab("Posts")}<tbody>${d.vinculos.pendentes.map((v) => linha(v.texto, `${v.posts} post(s), ${ddmm(v.de)}${v.ate !== v.de ? `–${ddmm(v.ate)}` : ""}`, "ligar")).join("")}</tbody></table></div>` : `<p class="mk-vazio">✓ Todos os posts têm turma ou tipo.</p>`}
      <h3 class="secao-titulo">Ligados automaticamente — confira (${autos.size})</h3>
      <div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab("Turma(s) escolhida(s)")}<tbody>${[...autos.values()].map((v) => linha(v.texto, v.turmas.map((t) => `${escapeHtml(t.nome)} (${ddmm(t.inicio)})`).join("<br>"), "corrigir")).join("")}</tbody></table></div>
      ${d.vinculos.manuais.length ? `<h3 class="secao-titulo">Ligados à mão (${d.vinculos.manuais.length})</h3><div class="tabela-scroll"><table class="tabela-metricas mk-tabela">${cab("Ligação")}<tbody>${d.vinculos.manuais.map((v) => linha(v.texto,
        v.vinculo === "turmas" ? v.turmas.map((id) => { const t = d.turmasParaVinculo.find((x) => x.id === id); return t ? `${escapeHtml(t.nome)} (${ddmm(t.inicio)})` : `turma #${id}`; }).join("<br>") : v.vinculo === "setor" ? `setor: ${escapeHtml(v.setor)}` : v.vinculo, "alterar")).join("")}</tbody></table></div>` : ""}`;
  }

  // ---------- importar (admin) ----------
  function renderImportar() {
    if (!estado.admin) return `<p class="texto-suave">Só o administrador importa o plano.</p>`;
    const r = pl.relatorio;
    return `<p class="texto-suave">Envie a planilha do mês (.xlsx, aba "Planner…" ou a primeira; colunas data, canal, etapa, curso/turma, tema/gancho, formato, dono, status…). Reimportar atualiza os textos; a DATA de um post nunca muda por importação (só pelo "replanejar"). Post que sumiu da planilha só sai do plano se ainda estava planejado e a data é futura.</p>
      <label class="btn-mini btn-primario pl-upload">📥 Escolher planilha (.xlsx)<input type="file" accept=".xlsx" id="pl-arquivo" class="oculto" /></label>
      ${r ? `<div class="pl-relatorio"><h3 class="secao-titulo">${escapeHtml(r.arquivo)} — aba "${escapeHtml(r.aba)}"</h3>
        <p>${r.linhas} post(s): <b>${r.novos}</b> novo(s), <b>${r.atualizados}</b> atualizado(s), ${r.saiuDoPlano} saíram do plano (futuros), ${r.mantidosForaDaPlanilha.length} mantido(s) apesar de sumir da planilha (já vencidos ou trabalhados).</p>
        <p>Turmas: ${Object.entries(r.vinculos).map(([k, n]) => `${k} ${n}`).join(" · ")} — ${r.pendentesVinculo} post(s) sem turma no total (ver "Turmas dos posts").</p>
        <p>Status do planner antigo aplicados: ${r.migrados.aplicados}${r.migrados.naoCasados.length ? ` · <span class="pl-pendente">não casaram: ${r.migrados.naoCasados.map((x) => escapeHtml(x.chave)).join(", ")}</span>` : ""}.</p>
        ${r.semResponsavel.length ? `<p class="pl-pendente">Sem responsável reconhecido no "Dono" (fora do indicador): ${r.semResponsavel.map((x) => `linha ${x.linha} "${escapeHtml(x.dono)}"`).join("; ")}</p>` : ""}
        ${r.ignoradas.length ? `<p class="texto-suave">Linhas ignoradas: ${r.ignoradas.map((x) => `${x.linha} (${x.motivo})`).join(", ")}</p>` : ""}</div>` : ""}
      <h3 class="secao-titulo">Meta de conversas por semana</h3>
      <div class="mk-controles"><input type="number" min="0" class="campo-select" id="pl-meta" value="${pl.d.metaConversas}" style="width:6rem" /><button type="button" class="btn-mini" data-pl-meta>Salvar</button></div>`;
  }

  // ---------- janela do post ----------
  const dlg = () => document.getElementById("pl-dlg");
  function abrirDlg(html) {
    const el = dlg();
    el.innerHTML = `<button type="button" class="pl-fechar" data-pl-fechar aria-label="Fechar">✕</button>${html}`;
    if (!el.open) { try { el.showModal(); } catch (_) { el.setAttribute("open", ""); } }
  }
  async function abrirPost(id) {
    const p = pl.d.posts.find((x) => x.id === id);
    if (!p) return;
    const podePublicado = p.estado !== "publicado" || estado.admin;
    const bloqueado = p.foraDoPlano || (p.estado === "nao_vai_sair" && !estado.admin);
    const seg = ["planejado", "produzido", "publicado"].map((s) => `<button type="button" data-pl-estado="${s}" aria-pressed="${p.estado === s}" ${bloqueado || (!podePublicado && s !== "publicado") ? "disabled" : ""}>${s[0].toUpperCase() + s.slice(1)}</button>`).join("");
    abrirDlg(`<div class="pl-post" data-id="${p.id}">
      <div class="pl-post-forma">${svg(forma(p), corEtapa(p.etapa), 84)}<span style="color:${corEtapa(p.etapa)}">${escapeHtml(p.etapa || "")}</span><small>${diaSemana(p.data)} ${dataBr(p.data)}${p.dataOriginal !== p.data ? ` <s>${dataBr(p.dataOriginal)}</s>` : ""}</small></div>
      <div class="pl-post-lado">
        <h3 id="pl-dlg-titulo">${escapeHtml(p.gancho || p.cursoTexto)}</h3>
        <div class="pl-tags"><span>${escapeHtml(p.canal)}</span><span>${escapeHtml(p.formato || "")}</span><span>${escapeHtml(p.dono || "")}</span>${p.situacaoPlanilha && norm(p.situacaoPlanilha) !== "planejado" ? `<span class="pl-tag-alerta" title="situação na planilha (informativa)">${escapeHtml(p.situacaoPlanilha)}</span>` : ""}</div>
        <p class="pl-vinc">${vinculoTexto(p)}</p>
        ${p.observacao ? `<p class="texto-suave">${escapeHtml(p.observacao)}</p>` : ""}
        <p>${seloPost(p)} <small class="texto-suave">atraso de ${NOME_RESP[p.responsavel] || "—"}${p.retroativo ? " · retroativo, fora do indicador" : ""}</small></p>
        <div class="pl-seg">${seg}</div>
        <label class="pl-campo">Link do post publicado (obrigatório para publicar)<input type="url" class="campo-select" name="link" value="${escapeHtml(p.link || "")}" placeholder="https://" ${bloqueado ? "disabled" : ""}/></label>
        <div class="pl-nums">
          <label class="pl-campo">Alcance<input type="number" min="0" class="campo-select" name="alcance" value="${p.alcance ?? ""}" /></label>
          <label class="pl-campo">Engajamento<input type="number" min="0" class="campo-select" name="engajamento" value="${p.engajamento ?? ""}" /></label>
          <label class="pl-campo">Conversas<input type="number" min="0" class="campo-select" name="conversas" value="${p.conversas ?? ""}" /></label>
        </div>
        <div class="mk-controles"><button type="button" class="btn-mini btn-primario" data-pl-salvar>Salvar</button><span class="texto-suave" id="pl-msg"></span></div>
        <p class="texto-suave pl-carimbos">${p.produzidoEm ? `Produzido ${escapeHtml(dataHoraBr(p.produzidoEm))}${p.produzidoPor ? ` · ${escapeHtml(p.produzidoPor)}` : ""}. ` : ""}${p.publicadoEm ? `Publicado ${escapeHtml(dataHoraBr(p.publicadoEm))}${p.publicadoPor ? ` · ${escapeHtml(p.publicadoPor)}` : ""}. ` : ""}${p.migrado ? "Estado trazido do planner antigo, sem carimbo. " : ""}${p.naoSaiEm ? `Não vai sair (${escapeHtml(dataHoraBr(p.naoSaiEm))}${p.naoSaiPor ? ` · ${escapeHtml(p.naoSaiPor)}` : ""}): ${escapeHtml(p.naoSaiMotivo)}` : ""}</p>
        ${!p.foraDoPlano && p.estado !== "publicado" && p.estado !== "nao_vai_sair" ? `<details class="pl-det"><summary>Não vai sair…</summary><div class="mk-controles"><input type="text" class="campo-select" name="naoSai" placeholder="motivo (obrigatório)" maxlength="300" /><button type="button" class="btn-mini" data-pl-naosai>Confirmar: não vai sair</button></div><small class="texto-suave">Sai das pendências e conta como não feito no indicador.</small></details>` : ""}
        ${estado.admin ? `<details class="pl-det"><summary>Replanejar (admin)</summary><div class="mk-controles"><input type="date" class="campo-select" name="novaData" value="${p.data}" /><input type="text" class="campo-select" name="motivoRep" placeholder="motivo (obrigatório)" maxlength="300" /><button type="button" class="btn-mini" data-pl-replanejar>Replanejar</button></div><small class="texto-suave">Muda a data de referência do atraso. Fica registrado.</small></details>` : ""}
        <details class="pl-det" data-pl-hist><summary>Histórico</summary><div class="texto-suave">carregando…</div></details>
      </div></div>`);
  }
  function abrirExtra(id) {
    const x = id ? pl.d.extras.find((e) => e.id === id) : null;
    const sel = (lista, atual) => lista.map((v) => `<option ${v === atual ? "selected" : ""}>${escapeHtml(v)}</option>`).join("") + (atual && !lista.includes(atual) ? `<option selected>${escapeHtml(atual)}</option>` : "");
    abrirDlg(`<div class="pl-extra" data-id="${x ? x.id : ""}"><h3 id="pl-dlg-titulo">${x ? "Feito extra" : "Novo feito extra"}</h3>
      <div class="pl-nums">
        <label class="pl-campo">Data<input type="date" class="campo-select" name="data" value="${x ? x.data : pl.d.hoje}" /></label>
        <label class="pl-campo">Formato<select class="campo-select" name="formato">${sel(FORMATOS_EXTRA, x ? x.formato : "Story")}</select></label>
        <label class="pl-campo">Canal<select class="campo-select" name="canal">${sel(CANAIS_EXTRA, x ? x.canal : "Instagram Stories")}</select></label>
      </div>
      <label class="pl-campo">O que foi feito<input type="text" class="campo-select" name="titulo" maxlength="140" value="${escapeHtml(x?.titulo || "")}" placeholder="Ex.: story com bastidor da aula de Tesouraria" /></label>
      <label class="pl-campo">Link (obrigatório)<input type="url" class="campo-select" name="link" value="${escapeHtml(x?.link || "")}" placeholder="https://" /></label>
      <div class="pl-nums">
        <label class="pl-campo">Alcance<input type="number" min="0" class="campo-select" name="alcance" value="${x?.alcance ?? ""}" /></label>
        <label class="pl-campo">Engajamento<input type="number" min="0" class="campo-select" name="engajamento" value="${x?.engajamento ?? ""}" /></label>
        <label class="pl-campo">Conversas<input type="number" min="0" class="campo-select" name="conversas" value="${x?.conversas ?? ""}" /></label>
      </div>
      <label class="pl-campo">Observação<textarea class="campo-select" name="obs" maxlength="400">${escapeHtml(x?.obs || "")}</textarea></label>
      <div class="mk-controles"><button type="button" class="btn-mini btn-primario" data-pl-xsalvar>Salvar</button>${x ? `<button type="button" class="btn-mini" data-pl-xexcluir>Excluir</button>` : ""}<span class="texto-suave" id="pl-msg"></span></div>
      ${x ? `<p class="texto-suave">Registrado ${escapeHtml(dataHoraBr(x.criadoEm))}${x.criadoPor ? ` · ${escapeHtml(x.criadoPor)}` : ""}</p>` : ""}</div>`);
  }
  const valoresDe = (raiz) => Object.fromEntries([...raiz.querySelectorAll("[name]")].map((i) => [i.name, i.value]));
  const msg = (t) => { const el = document.getElementById("pl-msg"); if (el) el.textContent = t; };

  // ---------- render / carga ----------
  const VISOES = { calendario: renderCalendario, semana: renderSemana, desempenho: renderDesempenho, vinculos: renderVinculos, importar: renderImportar };
  function render() {
    if (!pl.d) return;
    renderKpis();
    if (!estado.admin && (pl.visao === "vinculos" || pl.visao === "importar")) pl.visao = "calendario";
    document.querySelectorAll("[data-pl-visao]").forEach((b) => b.classList.toggle("ativo", b.dataset.plVisao === pl.visao));
    document.getElementById("pl-conteudo").innerHTML = VISOES[pl.visao]();
  }
  async function carregar() {
    try {
      pl.d = await chamarApi("/api/marketing/planner");
      if (estado.aba === "planner") render(); else renderKpis();
    } catch (e) { document.getElementById("pl-kpis").textContent = "⚠ " + e.message; }
  }
  async function recarregarEReabrir(idPost) {
    await carregar();
    if (idPost && dlg().open) abrirPost(idPost);
  }

  // ---------- eventos ----------
  const raiz = document.getElementById("aba-planner");
  raiz.addEventListener("click", async (ev) => {
    const b = (s) => ev.target.closest(s);
    let el;
    if ((el = b("[data-pl-visao]"))) { pl.visao = el.dataset.plVisao; pl.editandoVinculo = null; render(); return; }
    if ((el = b("[data-pl-mes]"))) {
      const ms = meses(), v = el.dataset.plMes;
      pl.mes = v === "hoje" ? pl.d.hoje.slice(0, 7) : ms[ms.indexOf(pl.mes) + Number(v)] || pl.mes; render(); return;
    }
    if ((el = b("[data-pl-semana]"))) { const v = el.dataset.plSemana; pl.semana = v === "hoje" ? segunda(pl.d.hoje) : somar(pl.semana, Number(v)); render(); return; }
    if ((el = b("[data-post]"))) { abrirPost(Number(el.dataset.post)); return; }
    if ((el = b("[data-extra]"))) { abrirExtra(Number(el.dataset.extra)); return; }
    if (b("[data-pl-extra]")) { abrirExtra(null); return; }
    if ((el = b("[data-pl-vabrir]"))) { pl.editandoVinculo = el.dataset.plVabrir; render(); return; }
    if (b("[data-pl-vcancelar]")) { pl.editandoVinculo = null; render(); return; }
    if (b("[data-pl-vsalvar]")) {
      const f = b("[data-pl-vsalvar]").closest(".pl-vinculo-form");
      const corpo = { texto: pl.editandoVinculo, vinculo: f.querySelector('[name="pl-vtipo"]:checked')?.value, setor: f.querySelector('[name="pl-vsetor"]').value,
        turmas: [...f.querySelectorAll(".pl-turmas-lista input:checked")].map((i) => Number(i.value)) };
      try { const r = await chamarApi("/api/marketing/planner/vinculos", json("PUT", corpo)); avisar(`Ligação salva para ${plural(r.posts, "post", "posts")}.`); pl.editandoVinculo = null; await carregar(); }
      catch (e) { avisar("⚠ " + e.message, true); }
      return;
    }
    if (b("[data-pl-meta]")) {
      try { await chamarApi("/api/marketing/planner/meta", json("PUT", { conversas: document.getElementById("pl-meta").value })); avisar("Meta de conversas salva."); await carregar(); }
      catch (e) { avisar("⚠ " + e.message, true); }
    }
  });
  raiz.addEventListener("input", (ev) => {
    if (ev.target.name !== "pl-vbusca") return;
    const q = norm(ev.target.value);
    ev.target.closest(".pl-vinculo-form").querySelectorAll(".pl-turmas-lista label").forEach((l) => { l.hidden = q && !l.dataset.busca.includes(q); });
  });
  raiz.addEventListener("change", async (ev) => {
    const t = ev.target;
    if (t.dataset.plFiltro) { pl.filtros[t.dataset.plFiltro] = t.value; render(); return; }
    if (t.dataset.plRotina) {
      try {
        const r = await chamarApi("/api/marketing/planner/rotina", json("PUT", { semana: pl.semana, item: t.dataset.plRotina, marcado: t.checked }));
        pl.d.rotina[pl.semana] = r.checks; render();
      } catch (e) { t.checked = !t.checked; avisar("⚠ Não salvou o check: " + e.message, true); }
      return;
    }
    if (t.dataset.plFech) {
      try { await chamarApi(`/api/marketing/planner/posts/${t.dataset.id}`, json("PATCH", { [t.dataset.plFech]: t.value })); avisar("Salvo."); await carregar(); }
      catch (e) { avisar("⚠ " + e.message, true); }
      return;
    }
    if (t.id === "pl-arquivo" && t.files[0]) {
      const f = t.files[0];
      avisar("Importando…");
      try {
        pl.relatorio = await chamarApi(`/api/marketing/planner/importar?arquivo=${encodeURIComponent(f.name)}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: await f.arrayBuffer() });
        avisar(`${pl.relatorio.linhas} post(s) importado(s).`);
        await carregar();
      } catch (e) { avisar("⚠ Não importou: " + e.message, true); }
      t.value = "";
    }
  });

  dlg().addEventListener("click", async (ev) => {
    const el = dlg();
    if (ev.target === el || ev.target.closest("[data-pl-fechar]")) { el.close(); return; }
    const caixa = ev.target.closest(".pl-post, .pl-extra");
    if (!caixa) return;
    const id = Number(caixa.dataset.id);
    const v = valoresDe(caixa);
    const b = (s) => ev.target.closest(s);
    try {
      if (b("[data-pl-estado]")) {
        const novo = b("[data-pl-estado]").dataset.plEstado;
        if (novo === "publicado" && !/^https?:\/\/\S+\.\S+/i.test(v.link.trim())) { msg("Cole o link do post publicado antes de marcar publicado."); caixa.querySelector('[name="link"]').focus(); return; }
        const { post } = await chamarApi(`/api/marketing/planner/posts/${id}/estado`, json("POST", { estado: novo, link: v.link }));
        avisar(novo === "publicado" ? `✓ Publicado${post.atrasoDias && !post.retroativo ? ` com ${plural(post.atrasoDias, "dia", "dias")} de atraso` : ""}.` : `Marcado como ${novo}.`);
        await recarregarEReabrir(id);
      } else if (b("[data-pl-salvar]")) {
        const p = pl.d.posts.find((x) => x.id === id);
        const corpo = { alcance: v.alcance, engajamento: v.engajamento, conversas: v.conversas };
        if (p.estado === "publicado" && v.link.trim() !== (p.link || "")) corpo.link = v.link;
        await chamarApi(`/api/marketing/planner/posts/${id}`, json("PATCH", corpo));
        avisar("Salvo."); await recarregarEReabrir(id);
      } else if (b("[data-pl-naosai]")) {
        await chamarApi(`/api/marketing/planner/posts/${id}/nao-vai-sair`, json("POST", { motivo: v.naoSai }));
        avisar("Marcado como \"não vai sair\" — conta como não feito."); await recarregarEReabrir(id);
      } else if (b("[data-pl-replanejar]")) {
        await chamarApi(`/api/marketing/planner/posts/${id}/replanejar`, json("POST", { data: v.novaData, motivo: v.motivoRep }));
        avisar("Post replanejado (registrado)."); await recarregarEReabrir(id);
      } else if (b("[data-pl-xsalvar]")) {
        if (!/^https?:\/\/\S+\.\S+/i.test(v.link.trim())) { msg("O link é obrigatório."); return; }
        await chamarApi(id ? `/api/marketing/planner/extras/${id}` : "/api/marketing/planner/extras", json(id ? "PUT" : "POST", v));
        el.close(); avisar("Feito extra salvo."); await carregar();
      } else if (b("[data-pl-xexcluir]")) {
        const bt = b("[data-pl-xexcluir]");
        if (bt.dataset.armado !== "1") { bt.dataset.armado = "1"; bt.textContent = "Confirmar exclusão"; bt.classList.add("btn-primario"); return; }
        await chamarApi(`/api/marketing/planner/extras/${id}`, json("DELETE"));
        el.close(); avisar("Feito extra excluído."); await carregar();
      }
    } catch (e) { msg("⚠ " + e.message); }
  });
  dlg().addEventListener("toggle", async (ev) => {
    const det = ev.target.closest?.("[data-pl-hist]");
    if (!det || !det.open) return;
    const id = Number(det.closest(".pl-post").dataset.id);
    try {
      const h = await chamarApi(`/api/marketing/planner/posts/${id}/historico`);
      const ACOES = { estado: "estado", editado: "edição", nao_vai_sair: "não vai sair", replanejado: "replanejado" };
      det.querySelector("div").innerHTML = h.eventos.length
        ? `<ul class="pl-hist">${h.eventos.map((e) => `<li>${escapeHtml(dataHoraBr(e.em))} · ${escapeHtml(e.usuario || "")} · ${ACOES[e.acao] || escapeHtml(e.acao)}${e.detalhe?.de ? `: ${escapeHtml(e.detalhe.de)} → ${escapeHtml(e.detalhe.para)}` : ""}${e.detalhe?.motivo ? ` — ${escapeHtml(e.detalhe.motivo)}` : ""}</li>`).join("")}</ul>`
        : "Nada registrado ainda.";
    } catch (e) { det.querySelector("div").textContent = "⚠ " + e.message; }
  }, true);

  window.PLANNER = { render, carregar };
  carregar();
  setInterval(() => { if (!dlg().open && !pl.editandoVinculo) carregar(); }, 5 * 60 * 1000);
})();

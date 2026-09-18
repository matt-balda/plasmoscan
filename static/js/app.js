/* =========================================================================
   Detecção de Malária com IA — lógica do frontend
   Contrato de API: GET /samples, POST /predict, GET /health
   Sem frameworks, sem dependências externas.
   ========================================================================= */

(function () {
  "use strict";

  /* -----------------------------------------------------------------------
     Constantes do contrato (classes, cores, nomes em português)
     ------------------------------------------------------------------- */

  var CLASS_COLORS = {
    "red blood cell": "#9CA3AF",
    "ring": "#F59E0B",
    "trophozoite": "#EF4444",
    "schizont": "#A855F7",
    "gametocyte": "#3B82F6",
    "leukocyte": "#22C55E",
    "difficult": "#6B7280"
  };

  var CLASS_LABELS_PT = {
    "red blood cell": "Hemácia",
    "ring": "Anel",
    "trophozoite": "Trofozoíto",
    "schizont": "Esquizonte",
    "gametocyte": "Gametócito",
    "leukocyte": "Leucócito",
    "difficult": "Indefinido"
  };

  var CLASS_DESCRIPTIONS_PT = {
    "ring": "O anel é o estágio inicial do parasita Plasmodium dentro da hemácia, logo após a invasão. Recebe esse nome porque se parece com um pequeno anel ao microscópio. É a forma mais comum encontrada em infecções, especialmente nas fases iniciais.",
    "trophozoite": "O trofozoíto é a forma em que o parasita cresce e se alimenta da hemoglobina dentro da hemácia. Nessa fase ele já é maior e mais irregular que o anel, indicando uma infecção em desenvolvimento.",
    "schizont": "O esquizonte é a fase madura do parasita, quando ele se multiplica dentro da hemácia antes de romper a célula e liberar novos parasitas na corrente sanguínea. Está associado aos picos de febre característicos da malária.",
    "gametocyte": "O gametócito é a forma sexuada do parasita, responsável pela transmissão da doença. Não causa os sintomas da malária diretamente, mas é essencial para o ciclo de vida do parasita quando um mosquito Anopheles pica a pessoa infectada.",
    "leukocyte": "O leucócito, ou glóbulo branco, é uma célula do sistema imunológico presente naturalmente no sangue. Não é um parasita, mas o modelo o identifica pois ele aparece nas lâminas e pode ser confundido com outras estruturas.",
    "difficult": "Esta categoria agrupa objetos que o modelo não conseguiu classificar com certeza em nenhuma das classes conhecidas. Podem ser artefatos da lâmina, sobreposições de células ou estágios atípicos do parasita.",
    "red blood cell": "As hemácias, ou glóbulos vermelhos, são as células responsáveis por transportar oxigênio pelo corpo. São também o alvo da infecção pelo Plasmodium, o parasita causador da malária."
  };

  // Ordem de desenho: infectadas em cima de tudo, hemácias por baixo (quando visíveis).
  var DRAW_ORDER = ["red blood cell", "leukocyte", "difficult", "gametocyte", "schizont", "trophozoite", "ring"];

  var ZOOM_MIN = 1;
  var ZOOM_MAX = 6;
  var ZOOM_DOUBLE_TAP = 2.5;
  var TAP_MOVE_THRESHOLD = 12; // px — acima disso, um gesto de toque conta como arraste, não toque
  var DOUBLE_TAP_MS = 320;

  /* -----------------------------------------------------------------------
     Estado global da aplicação
     ------------------------------------------------------------------- */

  var state = {
    mode: null,              // 'image' | 'camera'
    confidence: 0.25,
    showRBC: false,
    selectedClass: null,

    naturalWidth: 0,
    naturalHeight: 0,
    lastDetections: [],
    lastCounts: {},

    // zoom/pan estilo microscópio sobre a mídia analisada
    zoom: { scale: 1, tx: 0, ty: 0 },

    // payload reenviável ao mudar o slider de confiança
    lastPayload: null,       // { type: 'file', file } | { type: 'base64', dataUrl } | { type: 'slide', slideId }

    // câmera
    cameraStream: null,
    cameraTimer: null,
    cameraBusy: false,

    // upload
    inFlightController: null,

    // incrementado a cada nova sessão de análise (imagem, câmera ou lâmina de lote) para que
    // uma resposta atrasada de uma sessão anterior nunca sobrescreva a atual
    sessionId: 0,

    // lote (pasta com várias lâminas): { id, slides, index }
    batch: null,

    // anotação do especialista na lâmina atual do lote
    annotate: null
  };

  /* -----------------------------------------------------------------------
     Referências de elementos
     ------------------------------------------------------------------- */

  var els = {};

  function cacheEls() {
    els.views = {
      home: document.getElementById("view-home"),
      upload: document.getElementById("view-upload"),
      analysis: document.getElementById("view-analysis"),
      batchAnnotate: document.getElementById("view-batch-annotate"),
      batchReport: document.getElementById("view-batch-report")
    };

    els.btnCamera = document.getElementById("btn-camera");
    els.btnUpload = document.getElementById("btn-upload");
    els.btnUploadBack = document.getElementById("btn-upload-back");
    els.btnNewAnalysis = document.getElementById("btn-new-analysis");
    els.btnStageErrorBack = document.getElementById("btn-stage-error-back");

    els.samplesSection = document.getElementById("samples-section");
    els.samplesGallery = document.getElementById("samples-gallery");

    els.dropzone = document.getElementById("dropzone");
    els.fileInput = document.getElementById("file-input");
    els.folderInput = document.getElementById("folder-input");
    els.linkUploadFolder = document.getElementById("link-upload-folder");
    els.uploadBatchStatus = document.getElementById("upload-batch-status");

    els.resultImage = document.getElementById("result-image");
    els.cameraVideo = document.getElementById("camera-video");
    els.overlayCanvas = document.getElementById("overlay-canvas");
    els.mediaStage = document.getElementById("media-stage");
    els.zoomLayer = document.getElementById("zoom-layer");
    els.zoomHint = document.getElementById("zoom-hint");
    els.zoomControls = document.getElementById("zoom-controls");
    els.zoomBadge = document.getElementById("zoom-badge");
    els.btnZoomReset = document.getElementById("btn-zoom-reset");
    els.stagePlaceholder = document.getElementById("stage-placeholder");
    els.stagePlaceholderText = document.getElementById("stage-placeholder-text");
    els.stageError = document.getElementById("stage-error");
    els.stageErrorText = document.getElementById("stage-error-text");

    els.badgeLive = document.getElementById("badge-live");
    els.badgeInference = document.getElementById("badge-inference");
    els.badgeInferenceValue = document.getElementById("badge-inference-value");

    els.predictErrorBanner = document.getElementById("predict-error-banner");
    els.predictErrorText = document.getElementById("predict-error-text");

    els.infectionRate = document.getElementById("infection-rate");
    els.infectionSeverity = document.getElementById("infection-severity");
    els.infectionGaugeMarker = document.getElementById("infection-gauge-marker");
    els.toggleRBC = document.getElementById("toggle-rbc");
    els.confSlider = document.getElementById("conf-slider");
    els.confValue = document.getElementById("conf-value");
    els.chipsContainer = document.getElementById("chips-container");
    els.descriptionCard = document.getElementById("description-card");

    els.captureCanvas = document.getElementById("capture-canvas");

    // lote — tela de anotação do especialista (correção da proposta da IA)
    els.btnBatchAnnotateCancel = document.getElementById("btn-batch-annotate-cancel");
    els.annotateProgressBadge = document.getElementById("annotate-progress-badge");
    els.annotateLoading = document.getElementById("annotate-loading");
    els.annotateStage = document.getElementById("annotate-stage");
    els.annotateImage = document.getElementById("annotate-image");
    els.annotateCanvas = document.getElementById("annotate-canvas");
    els.annotatePickerTitle = document.getElementById("annotate-picker-title");
    els.annotateClassPicker = document.getElementById("annotate-class-picker");
    els.annotateList = document.getElementById("annotate-list");
    els.annotateCount = document.getElementById("annotate-count");
    els.btnAnnotateSkip = document.getElementById("btn-annotate-skip");
    els.btnAnnotateSave = document.getElementById("btn-annotate-save");

    // lote — tela de relatório final
    els.btnReportHome = document.getElementById("btn-report-home");
    els.btnReportNewBatch = document.getElementById("btn-report-new-batch");
    els.reportSlidesCount = document.getElementById("report-slides-count");
    els.reportTableWrap = document.getElementById("report-table-wrap");
  }

  /* -----------------------------------------------------------------------
     Navegação entre telas
     ------------------------------------------------------------------- */

  function showView(name) {
    Object.keys(els.views).forEach(function (key) {
      var view = els.views[key];
      if (!view) return;
      if (key === name) {
        view.classList.add("view-active");
      } else {
        view.classList.remove("view-active");
      }
    });

    if (name !== "analysis") {
      stopCamera();
    }
  }

  function goHome() {
    stopCamera();
    state.batch = null;
    resetAnalysisUI();
    showView("home");
  }

  /* -----------------------------------------------------------------------
     Tela inicial — amostras
     ------------------------------------------------------------------- */

  function loadSamples() {
    fetch("/samples")
      .then(function (resp) {
        if (!resp.ok) throw new Error("status " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        var samples = (data && data.samples) || [];
        renderSamples(samples);
      })
      .catch(function () {
        // Silencioso: seção de amostras simplesmente não aparece.
        renderSamples([]);
      });
  }

  function renderSamples(samples) {
    els.samplesGallery.innerHTML = "";

    if (!samples || samples.length === 0) {
      els.samplesSection.hidden = true;
      return;
    }

    els.samplesSection.hidden = false;

    samples.forEach(function (sample) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sample-thumb";
      btn.title = sample.caption || sample.id || "amostra";

      var img = document.createElement("img");
      img.src = sample.url;
      img.alt = sample.caption || "Imagem de amostra de microscopia";
      img.loading = "lazy";
      btn.appendChild(img);

      if (sample.caption) {
        var cap = document.createElement("span");
        cap.className = "sample-caption";
        cap.textContent = sample.caption;
        btn.appendChild(cap);
      }

      btn.addEventListener("click", function () {
        useSampleImage(sample);
      });

      els.samplesGallery.appendChild(btn);
    });
  }

  function useSampleImage(sample) {
    showView("analysis");
    startImageAnalysisFromUrl(sample.url);
  }

  /* -----------------------------------------------------------------------
     Fluxo de UPLOAD
     ------------------------------------------------------------------- */

  function goToUpload() {
    showView("upload");
  }

  function setupUpload() {
    els.dropzone.addEventListener("click", function (e) {
      // Evita disparo duplo quando o clique já vem do <label for>.
      if (e.target === els.fileInput) return;
    });

    els.dropzone.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        els.fileInput.click();
      }
    });

    els.fileInput.addEventListener("change", function () {
      var file = els.fileInput.files && els.fileInput.files[0];
      if (file) {
        handleFileChosen(file);
      }
      els.fileInput.value = "";
    });

    ["dragenter", "dragover"].forEach(function (evtName) {
      els.dropzone.addEventListener(evtName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        els.dropzone.classList.add("drag-over");
      });
    });

    ["dragleave", "dragend"].forEach(function (evtName) {
      els.dropzone.addEventListener(evtName, function (e) {
        e.preventDefault();
        els.dropzone.classList.remove("drag-over");
      });
    });

    els.dropzone.addEventListener("drop", function (e) {
      e.preventDefault();
      e.stopPropagation();
      els.dropzone.classList.remove("drag-over");
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      var imageFiles = Array.prototype.slice.call(files).filter(isImageFile);
      if (imageFiles.length === 0) return;
      if (imageFiles.length === 1) {
        handleFileChosen(imageFiles[0]);
      } else {
        startBatchUpload(imageFiles);
      }
    });
  }

  function isImageFile(file) {
    if (file.type && file.type.indexOf("image/") === 0) return true;
    return /\.(jpe?g|png|bmp|tiff?|webp)$/i.test(file.name || "");
  }

  function handleFileChosen(file) {
    showView("analysis");
    startImageAnalysisFromFile(file);
  }

  /* -----------------------------------------------------------------------
     Tela de análise — preparação comum
     ------------------------------------------------------------------- */

  function resetAnalysisUI() {
    state.sessionId += 1;
    state.mode = null;
    state.lastDetections = [];
    state.lastCounts = {};
    state.lastPayload = null;
    state.selectedClass = null;

    // Cada nova análise (novo visitante/nova imagem/nova lâmina) começa com os
    // padrões do contrato: hemácias ocultas e confiança em 0.25.
    state.confidence = 0.25;
    state.showRBC = false;
    els.toggleRBC.checked = false;
    els.confSlider.value = "0.25";
    els.confValue.textContent = "0.25";

    els.mediaStage.classList.remove("stage-live-mode");

    els.resultImage.hidden = true;
    els.resultImage.removeAttribute("src");
    els.cameraVideo.hidden = true;
    els.badgeLive.hidden = true;
    els.badgeInference.hidden = true;
    els.btnNewAnalysis.hidden = false;
    els.stagePlaceholder.hidden = true;
    els.stageError.hidden = true;
    els.predictErrorBanner.hidden = true;

    clearCanvas();
    renderChips({});
    updateInfectionRate(null);
    resetDescription();

    resetZoom(false);
    showZoomHint();
  }

  function showStagePlaceholder(text) {
    els.stageError.hidden = true;
    els.stagePlaceholderText.textContent = text;
    els.stagePlaceholder.hidden = false;
  }

  function hideStagePlaceholder() {
    els.stagePlaceholder.hidden = true;
  }

  function showStageError(text) {
    els.stagePlaceholder.hidden = true;
    els.stageErrorText.textContent = text;
    els.stageError.hidden = false;
  }

  function hideStageError() {
    els.stageError.hidden = true;
  }

  function showPredictError(message) {
    els.predictErrorText.textContent = message;
    els.predictErrorBanner.hidden = false;
  }

  function hidePredictError() {
    els.predictErrorBanner.hidden = true;
  }

  /* -----------------------------------------------------------------------
     Modo imagem estática (upload ou amostra)
     ------------------------------------------------------------------- */

  function startImageAnalysisFromFile(file) {
    resetAnalysisUI();
    state.mode = "image";

    els.resultImage.hidden = false;
    els.resultImage.src = URL.createObjectURL(file);

    state.lastPayload = { type: "file", file: file };
    showStagePlaceholder("Analisando imagem…");
    runPredictForImage();
  }

  function startImageAnalysisFromUrl(url) {
    resetAnalysisUI();
    state.mode = "image";

    els.resultImage.hidden = false;
    els.resultImage.src = url;

    showStagePlaceholder("Analisando imagem…");

    // Converte a amostra para base64 para reenvio consistente ao mudar o slider.
    var sessionId = state.sessionId;
    fetch(url)
      .then(function (r) { return r.blob(); })
      .then(function (blob) {
        return blobToDataUrl(blob);
      })
      .then(function (dataUrl) {
        if (sessionId !== state.sessionId) return; // usuário já saiu desta sessão
        state.lastPayload = { type: "base64", dataUrl: dataUrl };
        runPredictForImage();
      })
      .catch(function () {
        if (sessionId !== state.sessionId) return;
        showStageError("Não foi possível carregar a imagem de amostra.");
      });
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function runPredictForImage() {
    if (!state.lastPayload) return;
    hidePredictError();

    if (state.inFlightController) {
      state.inFlightController.abort();
    }
    var controller = ("AbortController" in window) ? new AbortController() : null;
    state.inFlightController = controller;
    var sessionId = state.sessionId;

    predict(state.lastPayload, state.confidence, controller)
      .then(function (data) {
        if (sessionId !== state.sessionId) return; // sessão trocada enquanto aguardava
        hideStagePlaceholder();
        hideStageError();
        applyPredictionResult(data);
      })
      .catch(function (err) {
        if (sessionId !== state.sessionId) return;
        if (err && err.name === "AbortError") return;
        hideStagePlaceholder();
        showPredictError(errorMessageFrom(err));
      });
  }

  /* -----------------------------------------------------------------------
     Modo câmera ao vivo
     ------------------------------------------------------------------- */

  function startCameraFlow() {
    resetAnalysisUI();
    state.mode = "camera";
    showView("analysis");

    // Marca o palco como "captura ao vivo" — acentua as marcas de canto
    // (corner-brackets), reforçando a leitura de mira/instrumento em operação.
    els.mediaStage.classList.add("stage-live-mode");

    els.cameraVideo.hidden = false;
    els.badgeLive.hidden = false;
    showStagePlaceholder("Solicitando acesso à câmera…");

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showStageError("Este navegador não tem suporte para acesso à câmera.");
      els.badgeLive.hidden = true;
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    }).then(function (stream) {
      state.cameraStream = stream;
      els.cameraVideo.srcObject = stream;
      return els.cameraVideo.play();
    }).then(function () {
      hideStagePlaceholder();
      startCameraLoop();
    }).catch(function (err) {
      els.badgeLive.hidden = true;
      showStageError(cameraErrorMessage(err));
    });
  }

  function cameraErrorMessage(err) {
    var name = err && err.name;
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Permissão de câmera negada. Habilite o acesso à câmera nas configurações do navegador e tente novamente.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "Nenhuma câmera foi encontrada neste dispositivo.";
    }
    return "Não foi possível acessar a câmera. Verifique as permissões do navegador.";
  }

  function startCameraLoop() {
    stopCameraTimer();
    state.cameraTimer = setInterval(captureAndPredictFrame, 700);
    captureAndPredictFrame();
  }

  function stopCameraTimer() {
    if (state.cameraTimer) {
      clearInterval(state.cameraTimer);
      state.cameraTimer = null;
    }
  }

  function captureAndPredictFrame() {
    if (state.mode !== "camera" || state.cameraBusy) return;
    if (!els.cameraVideo.videoWidth) return;

    var canvas = els.captureCanvas;
    canvas.width = els.cameraVideo.videoWidth;
    canvas.height = els.cameraVideo.videoHeight;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(els.cameraVideo, 0, 0, canvas.width, canvas.height);

    var dataUrl;
    try {
      dataUrl = canvas.toDataURL("image/jpeg", 0.7);
    } catch (e) {
      return;
    }

    state.cameraBusy = true;
    var sessionId = state.sessionId;
    predict({ type: "base64", dataUrl: dataUrl }, state.confidence, null)
      .then(function (data) {
        state.cameraBusy = false;
        if (sessionId !== state.sessionId || state.mode !== "camera") return;
        hidePredictError();
        applyPredictionResult(data);
      })
      .catch(function (err) {
        state.cameraBusy = false;
        if (sessionId !== state.sessionId || state.mode !== "camera") return;
        showPredictError(errorMessageFrom(err));
      });
  }

  function stopCamera() {
    stopCameraTimer();
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach(function (track) { track.stop(); });
      state.cameraStream = null;
    }
    els.cameraVideo.srcObject = null;
    state.cameraBusy = false;
  }

  /* -----------------------------------------------------------------------
     Fluxo de LOTE (pasta com várias lâminas)

     A IA propõe, o especialista corrige — não o contrário. Para cada
     lâmina: 1) a IA detecta automaticamente e pré-preenche as caixas;
     2) o especialista corrige (apaga falso-positivo, adiciona o que faltou,
     reclassifica); 3) o resultado corrigido vira o gabarito da lâmina e
     avança para a próxima, ou para o relatório final ao acabar o lote.
     ------------------------------------------------------------------- */

  var ANNOTATE_AI_CONF = 0.25; // mesmo padrão de inference.DEFAULT_CONF

  function setupBatchUpload() {
    els.linkUploadFolder.addEventListener("click", function () {
      els.folderInput.click();
    });

    els.folderInput.addEventListener("change", function () {
      var files = Array.prototype.slice.call(els.folderInput.files || []).filter(isImageFile);
      els.folderInput.value = "";
      if (files.length === 0) {
        window.alert("Nenhuma imagem válida encontrada na pasta selecionada.");
        return;
      }
      startBatchUpload(files);
    });
  }

  function startBatchUpload(files) {
    els.uploadBatchStatus.hidden = false;
    els.uploadBatchStatus.textContent = "Enviando " + files.length + (files.length === 1 ? " imagem…" : " imagens…");
    els.dropzone.classList.add("dropzone-disabled");

    fetchJson("/api/batches", { method: "POST" })
      .then(function (data) {
        var batchId = data.batch_id;
        var form = new FormData();
        files.forEach(function (f) { form.append("images", f); });
        return fetchJson("/api/batches/" + batchId + "/slides", { method: "POST", body: form })
          .then(function (data2) {
            return { batchId: batchId, slides: data2.slides, skipped: data2.skipped || 0 };
          });
      })
      .then(function (result) {
        els.uploadBatchStatus.hidden = true;
        els.dropzone.classList.remove("dropzone-disabled");
        state.batch = { id: result.batchId, slides: result.slides, index: 0 };
        if (result.skipped > 0) {
          window.setTimeout(function () {
            window.alert(result.skipped + " arquivo(s) foram ignorados por não serem imagens válidas.");
          }, 50);
        }
        goToBatchSlide(0);
      })
      .catch(function (err) {
        els.uploadBatchStatus.hidden = true;
        els.dropzone.classList.remove("dropzone-disabled");
        window.alert(errorMessageFrom(err));
      });
  }

  function cancelBatch() {
    state.batch = null;
    goHome();
  }

  function goToBatchSlide(index) {
    if (!state.batch) return;
    if (index >= state.batch.slides.length) {
      showBatchReport();
      return;
    }
    state.batch.index = index;
    startAnnotateForSlide(state.batch.slides[index]);
  }

  function updateBatchProgressBadge() {
    if (!state.batch) return;
    els.annotateProgressBadge.textContent =
      "Lâmina " + (state.batch.index + 1) + " de " + state.batch.slides.length;
  }

  /* --- Correção do especialista sobre a proposta da IA --------------------

     A IA detecta primeiro (pré-preenche as caixas); o especialista corrige:
     apaga falso-positivo, adiciona o que faltou, reclassifica um estágio.
     O resultado corrigido vira o gabarito da lâmina — não uma anotação
     paralela e independente da IA.
     ------------------------------------------------------------------- */

  var annotateDrag = null; // { start: {x,y}, current: {x,y} } em coordenadas naturais da imagem

  function startAnnotateForSlide(slide) {
    resetAnnotateUI();
    els.annotateImage.src = slide.url;
    updateBatchProgressBadge();
    showView("batchAnnotate");
    runAiProposalForSlide(slide);
  }

  function runAiProposalForSlide(slide) {
    state.annotate.loading = true;
    els.annotateLoading.hidden = false;
    els.btnAnnotateSave.disabled = true;
    els.btnAnnotateSkip.disabled = true;

    var sessionId = state.sessionId;
    predict({ type: "slide", slideId: slide.id }, ANNOTATE_AI_CONF, null)
      .then(function (data) {
        if (sessionId !== state.sessionId || !state.annotate) return;
        state.annotate.boxes = (data.detections || []).map(function (d) {
          return { class_name: d.class_name, box: d.box.slice(), source: "ai" };
        });
        finishAiProposal();
      })
      .catch(function (err) {
        if (sessionId !== state.sessionId || !state.annotate) return;
        window.alert("A IA não conseguiu propor detecções para esta lâmina (" + errorMessageFrom(err) + "). Anote manualmente.");
        finishAiProposal();
      });
  }

  function finishAiProposal() {
    state.annotate.loading = false;
    els.annotateLoading.hidden = true;
    els.btnAnnotateSave.disabled = false;
    els.btnAnnotateSkip.disabled = false;
    renderAnnotateList();
    redrawAnnotateCanvas();
  }

  function resetAnnotateUI() {
    state.annotate = {
      boxes: [],
      loading: false,
      activeClass: (state.annotate && state.annotate.activeClass) || "red blood cell",
      selectedIndex: null, // caixa existente clicada p/ inspecionar ou reclassificar
      naturalWidth: 0,
      naturalHeight: 0
    };
    annotateDrag = null;
    els.annotateImage.removeAttribute("src");
    els.annotateLoading.hidden = true;
    renderAnnotateClassPicker();
    renderAnnotateList();
    clearAnnotateCanvas();
  }

  function clearAnnotateCanvas() {
    var ctx = els.annotateCanvas.getContext("2d");
    ctx.clearRect(0, 0, els.annotateCanvas.width, els.annotateCanvas.height);
  }

  // Duas maneiras de usar este seletor de classe:
  // 1) nada selecionado no stage -> escolhe a classe da PRÓXIMA caixa a desenhar;
  // 2) uma caixa existente selecionada (clique no stage ou na lista) -> reclassifica
  //    aquela caixa na hora, sem precisar apagar e redesenhar.
  function renderAnnotateClassPicker() {
    var selected = getSelectedAnnotateBox();
    els.annotatePickerTitle.textContent = selected
      ? "Reclassificar caixa selecionada"
      : "Classe para a próxima caixa";
    var effectiveClass = selected ? selected.class_name : state.annotate.activeClass;

    els.annotateClassPicker.innerHTML = "";
    DRAW_ORDER.forEach(function (name) {
      var color = CLASS_COLORS[name] || "#5B93FF";
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.setProperty("--chip-color", color);
      if (effectiveClass === name) chip.classList.add("chip-selected");

      var dot = document.createElement("span");
      dot.className = "chip-dot";
      var label = document.createElement("span");
      label.textContent = CLASS_LABELS_PT[name] || name;
      chip.appendChild(dot);
      chip.appendChild(label);

      chip.addEventListener("click", function () {
        if (state.annotate.selectedIndex !== null) {
          reclassifySelectedAnnotateBox(name);
        } else {
          state.annotate.activeClass = name;
          renderAnnotateClassPicker();
        }
      });

      els.annotateClassPicker.appendChild(chip);
    });
  }

  function getSelectedAnnotateBox() {
    var idx = state.annotate.selectedIndex;
    return (idx !== null && state.annotate.boxes[idx]) ? state.annotate.boxes[idx] : null;
  }

  // Aplica a nova classe à caixa selecionada e volta ao modo normal (próxima
  // caixa) — o clique já respondeu "o que é isto?"; escolher uma classe
  // diferente é a correção em si.
  function reclassifySelectedAnnotateBox(name) {
    var box = getSelectedAnnotateBox();
    if (box && box.class_name !== name) {
      box.class_name = name;
      box.source = "human"; // foi corrigida pelo especialista, não é mais só proposta da IA
    }
    selectAnnotateBox(null);
  }

  // Seleciona (ou desseleciona, se idx já era o selecionado) uma caixa
  // existente para inspeção/reclassificação — usado tanto pelo clique no
  // stage quanto pelo clique na lista de caixas confirmadas.
  function selectAnnotateBox(idx) {
    var next = (idx === undefined || idx === null) ? null : idx;
    state.annotate.selectedIndex = (state.annotate.selectedIndex === next) ? null : next;
    renderAnnotateClassPicker();
    renderAnnotateList();
    redrawAnnotateCanvas();
  }

  function renderAnnotateList() {
    els.annotateCount.textContent = state.annotate.boxes.length;
    els.annotateList.innerHTML = "";

    if (state.annotate.boxes.length === 0) {
      var empty = document.createElement("p");
      empty.className = "chips-empty";
      empty.textContent = state.annotate.loading
        ? "Aguardando a proposta da IA…"
        : "Nenhuma caixa — a IA não propôs nada e nada foi adicionado.";
      els.annotateList.appendChild(empty);
      return;
    }

    state.annotate.boxes.forEach(function (b, idx) {
      var row = document.createElement("div");
      row.className = "annotate-row";
      if (idx === state.annotate.selectedIndex) row.classList.add("annotate-row-selected");

      var dot = document.createElement("span");
      dot.className = "chip-dot";
      dot.style.background = CLASS_COLORS[b.class_name] || "#5B93FF";

      var label = document.createElement("span");
      label.className = "annotate-row-label";
      label.textContent = CLASS_LABELS_PT[b.class_name] || b.class_name;

      var source = document.createElement("span");
      source.className = "annotate-row-source annotate-row-source-" + (b.source || "human");
      source.textContent = b.source === "ai" ? "IA" : "manual";

      var del = document.createElement("button");
      del.type = "button";
      del.className = "annotate-row-del";
      del.setAttribute("aria-label", "Remover caixa");
      del.textContent = "×";
      del.addEventListener("click", function (e) {
        e.stopPropagation(); // não deixa o clique do X também disparar a seleção da linha
        state.annotate.boxes.splice(idx, 1);
        if (state.annotate.selectedIndex === idx) {
          state.annotate.selectedIndex = null;
        } else if (state.annotate.selectedIndex !== null && state.annotate.selectedIndex > idx) {
          state.annotate.selectedIndex -= 1;
        }
        renderAnnotateList();
        renderAnnotateClassPicker();
        redrawAnnotateCanvas();
      });

      // Clicar na linha seleciona a mesma caixa que clicar nela no stage —
      // útil quando a caixa é pequena demais pra acertar com precisão na imagem.
      row.addEventListener("click", function () {
        selectAnnotateBox(idx);
      });

      row.appendChild(dot);
      row.appendChild(label);
      row.appendChild(source);
      row.appendChild(del);
      els.annotateList.appendChild(row);
    });
  }

  function annotateLayout() {
    return computeContainLayout(
      state.annotate.naturalWidth, state.annotate.naturalHeight,
      els.annotateImage.clientWidth, els.annotateImage.clientHeight
    );
  }

  function annotateStageLocalPoint(clientX, clientY) {
    var rect = els.annotateStage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function displayToNatural(px, py) {
    var layout = annotateLayout();
    if (!layout) return null;
    return {
      x: clampNum((px - layout.offsetX) / layout.scaleX, 0, state.annotate.naturalWidth),
      y: clampNum((py - layout.offsetY) / layout.scaleY, 0, state.annotate.naturalHeight)
    };
  }

  function normalizeBox(a, b) {
    return [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)];
  }

  // Acha a caixa existente sob o ponto (coordenadas naturais da imagem) —
  // quando várias se sobrepõem, prioriza a menor (mais específica), já que
  // uma "red blood cell" grande costuma conter caixas de parasita menores.
  function hitTestAnnotateBox(point) {
    var bestIdx = null, bestArea = Infinity;
    state.annotate.boxes.forEach(function (b, idx) {
      var box = b.box;
      if (point.x < box[0] || point.x > box[2] || point.y < box[1] || point.y > box[3]) return;
      var area = Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
      if (area < bestArea) {
        bestArea = area;
        bestIdx = idx;
      }
    });
    return bestIdx;
  }

  function onAnnotatePointerDown(e) {
    if (!state.annotate.naturalWidth) return;
    els.annotateStage.setPointerCapture(e.pointerId);
    var local = annotateStageLocalPoint(e.clientX, e.clientY);
    var natural = displayToNatural(local.x, local.y);
    if (!natural) return;
    annotateDrag = { start: natural, current: natural };
    redrawAnnotateCanvas();
  }

  function onAnnotatePointerMove(e) {
    if (!annotateDrag) return;
    var local = annotateStageLocalPoint(e.clientX, e.clientY);
    var natural = displayToNatural(local.x, local.y);
    if (!natural) return;
    annotateDrag.current = natural;
    redrawAnnotateCanvas();
  }

  function onAnnotatePointerUp() {
    if (!annotateDrag) return;
    var start = annotateDrag.start;
    var current = annotateDrag.current;
    var layout = annotateLayout();
    annotateDrag = null;

    // Gesto quase parado (sem arrasto perceptível) = clique: seleciona a
    // caixa existente sob o ponto para inspecionar/reclassificar, em vez de
    // desenhar uma caixa nova ali.
    var clickThresholdNatural = layout ? (6 / Math.max(layout.scaleX, 0.0001)) : 6;
    if (Math.hypot(current.x - start.x, current.y - start.y) <= clickThresholdNatural) {
      selectAnnotateBox(hitTestAnnotateBox(current));
      return;
    }

    var box = normalizeBox(start, current);
    var minSizeNatural = layout ? (8 / Math.max(layout.scaleX, 0.0001)) : 8;
    if ((box[2] - box[0]) >= minSizeNatural && (box[3] - box[1]) >= minSizeNatural) {
      state.annotate.boxes.push({ class_name: state.annotate.activeClass, box: box, source: "human" });
    }
    // Desenhar uma caixa nova encerra qualquer seleção/reclassificação em curso.
    selectAnnotateBox(null);
  }

  // Redimensionar o <canvas> (mudar .width/.height) durante um arrasto com
  // pointer capture ativo faz o Chromium disparar "pointercancel" e abortar o
  // gesto — por isso só tocamos o tamanho do canvas quando ele realmente muda,
  // nunca dentro do redesenho a cada pointermove.
  function sizeAnnotateCanvas() {
    var displayW = els.annotateImage.clientWidth;
    var displayH = els.annotateImage.clientHeight;
    if (!displayW || !displayH) return false;

    var canvas = els.annotateCanvas;
    var dpr = window.devicePixelRatio || 1;
    var targetW = Math.round(displayW * dpr);
    var targetH = Math.round(displayH * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = displayW + "px";
      canvas.style.height = displayH + "px";
    }
    return true;
  }

  function redrawAnnotateCanvas() {
    if (!state.annotate) return;
    if (!sizeAnnotateCanvas()) return;

    var canvas = els.annotateCanvas;
    var dpr = window.devicePixelRatio || 1;
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    var layout = annotateLayout();
    if (!layout) return;

    state.annotate.boxes.forEach(function (b, idx) {
      drawAnnotateBox(ctx, b, layout, false, idx === state.annotate.selectedIndex);
    });

    if (annotateDrag) {
      var box = normalizeBox(annotateDrag.start, annotateDrag.current);
      drawAnnotateBox(ctx, { class_name: state.annotate.activeClass, box: box }, layout, true, false);
    }
  }

  function drawAnnotateBox(ctx, det, layout, isDraft, isSelected) {
    var box = det.box;
    var x1 = layout.offsetX + box[0] * layout.scaleX;
    var y1 = layout.offsetY + box[1] * layout.scaleY;
    var x2 = layout.offsetX + box[2] * layout.scaleX;
    var y2 = layout.offsetY + box[3] * layout.scaleY;
    var color = CLASS_COLORS[det.class_name] || "#5B93FF";

    // Caixas propostas pela IA e ainda não tocadas ficam pontilhadas mais
    // finas, para o especialista ver de relance o que ele mesmo confirmou/
    // adicionou (traço sólido) e o que ainda é só sugestão da IA.
    var isAiProposal = !isDraft && det.source === "ai";

    ctx.save();
    ctx.lineWidth = isSelected ? 3 : (isAiProposal ? 1.5 : 2);
    ctx.strokeStyle = color;
    ctx.setLineDash(isDraft ? [4, 3] : (isAiProposal ? [2, 2] : []));
    ctx.globalAlpha = isDraft ? 0.75 : 1;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.restore();

    // Caixa selecionada (clique p/ inspecionar/reclassificar) ganha um anel
    // branco por fora, visível independente da cor da própria classe.
    if (isSelected) {
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.95;
      ctx.strokeRect(x1 - 3, y1 - 3, (x2 - x1) + 6, (y2 - y1) + 6);
      ctx.restore();
    }
  }

  function setupAnnotateInteractions() {
    // Backstop para navegadores que ignoram draggable="false"/-webkit-user-drag:
    // sem isso, um arrasto iniciado sobre a <img> pode virar um "arrastar
    // imagem" nativo e cancelar o desenho da caixa no meio do gesto.
    els.annotateStage.addEventListener("dragstart", function (e) { e.preventDefault(); });
    els.annotateStage.addEventListener("pointerdown", onAnnotatePointerDown);
    els.annotateStage.addEventListener("pointermove", onAnnotatePointerMove);
    els.annotateStage.addEventListener("pointerup", onAnnotatePointerUp);
    els.annotateStage.addEventListener("pointercancel", function () {
      annotateDrag = null;
      redrawAnnotateCanvas();
    });

    els.annotateImage.addEventListener("load", function () {
      state.annotate.naturalWidth = els.annotateImage.naturalWidth;
      state.annotate.naturalHeight = els.annotateImage.naturalHeight;
      redrawAnnotateCanvas();
    });

    els.btnAnnotateSkip.addEventListener("click", function () {
      // Não avalia esta lâmina: a proposta da IA já foi salva pelo predict,
      // mas ela fica de fora do gabarito (sem validação do especialista).
      goToBatchSlide(state.batch.index + 1);
    });

    els.btnAnnotateSave.addEventListener("click", function () {
      var slide = state.batch.slides[state.batch.index];
      var boxes = state.annotate.boxes.map(function (b) {
        return { class_name: b.class_name, box: b.box };
      });
      fetchJson("/api/slides/" + slide.id + "/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ boxes: boxes })
      })
        .then(function () {
          goToBatchSlide(state.batch.index + 1);
        })
        .catch(function (err) {
          window.alert(errorMessageFrom(err));
        });
    });

    els.btnBatchAnnotateCancel.addEventListener("click", cancelBatch);
  }

  /* --- Relatório final do lote (desempenho da IA validado pelo especialista) --- */

  function showBatchReport() {
    var batchId = state.batch.id;
    showView("batchReport");
    els.reportTableWrap.innerHTML = "<p class=\"chips-empty\">Carregando relatório…</p>";

    fetchJson("/api/batches/" + batchId + "/report")
      .then(renderBatchReport)
      .catch(function (err) {
        els.reportTableWrap.innerHTML = "";
        window.alert(errorMessageFrom(err));
      });
  }

  function renderBatchReport(data) {
    els.reportSlidesCount.textContent =
      data.slides_count + (data.slides_count === 1 ? " lâmina analisada" : " lâminas analisadas");

    var gt = data.ground_truth;
    document.getElementById("report-gt-rate").textContent = formatRateOrNA(gt.infection_rate_pct);
    document.getElementById("report-gt-rbc").textContent = gt.rbc_count;
    document.getElementById("report-gt-infected").textContent = gt.infected_count;
    document.getElementById("report-gt-n").textContent = gt.slides_reviewed;

    var ai = data.ai_performance;
    document.getElementById("report-ai-precision").textContent = formatRateOrNA(ai.precision_pct);
    document.getElementById("report-ai-recall").textContent = formatRateOrNA(ai.recall_pct);
    document.getElementById("report-ai-f1").textContent = formatRateOrNA(ai.f1_pct);
    document.getElementById("report-ai-n").textContent = ai.slides_evaluated;
    document.getElementById("report-ai-tp").textContent = ai.tp;
    document.getElementById("report-ai-fp").textContent = ai.fp;
    document.getElementById("report-ai-fn").textContent = ai.fn;

    els.reportTableWrap.innerHTML = "";
    var table = document.createElement("table");
    table.className = "report-table";
    var thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>Lâmina</th><th>Taxa de infecção (validada)</th><th>Precisão da IA</th><th>Revocação da IA</th></tr>";
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    (data.per_slide || []).forEach(function (slide) {
      var tr = document.createElement("tr");

      var tdName = document.createElement("td");
      tdName.textContent = slide.filename;

      var tdRate = document.createElement("td");
      tdRate.textContent = formatSlideGroundTruth(slide.ground_truth);

      var tdPrecision = document.createElement("td");
      var tdRecall = document.createElement("td");
      if (slide.ai) {
        tdPrecision.textContent = formatRateOrNA(slide.ai.precision_pct);
        tdRecall.textContent = formatRateOrNA(slide.ai.recall_pct);
      } else {
        tdPrecision.textContent = "—";
        tdRecall.textContent = "—";
      }

      tr.appendChild(tdName);
      tr.appendChild(tdRate);
      tr.appendChild(tdPrecision);
      tr.appendChild(tdRecall);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    els.reportTableWrap.appendChild(table);
  }

  function formatRateOrNA(pct) {
    return (pct === null || pct === undefined) ? "N/A" : formatPct(pct) + "%";
  }

  function formatSlideGroundTruth(stats) {
    if (!stats) return "— não avaliada pelo especialista";
    return stats.infected_count + " / " + stats.rbc_count + " hemácias (" + formatRateOrNA(stats.infection_rate_pct) + ")";
  }

  function setupReportControls() {
    els.btnReportHome.addEventListener("click", goHome);
    els.btnReportNewBatch.addEventListener("click", function () {
      state.batch = null;
      showView("upload");
    });
  }

  /* -----------------------------------------------------------------------
     Chamada à API /predict
     ------------------------------------------------------------------- */

  function predict(payload, conf, controller) {
    var opts = { method: "POST" };
    if (controller) opts.signal = controller.signal;
    var url;

    if (payload.type === "file") {
      var form = new FormData();
      form.append("image", payload.file);
      form.append("conf", String(conf));
      opts.body = form;
      url = "/predict?conf=" + encodeURIComponent(conf);
    } else if (payload.type === "slide") {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify({ conf: conf });
      url = "/api/slides/" + payload.slideId + "/predict";
    } else {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify({ image_base64: payload.dataUrl, conf: conf });
      url = "/predict?conf=" + encodeURIComponent(conf);
    }

    return fetchJson(url, opts);
  }

  // Helper genérico de fetch: valida JSON + o campo "ok" do contrato e
  // rejeita com um Error com mensagem amigável em pt-BR, pronta para
  // errorMessageFrom(). Usado pelo /predict e por todas as rotas de lote.
  function fetchJson(url, opts) {
    return fetch(url, opts).then(function (resp) {
      return resp.json().catch(function () {
        throw new Error("Resposta inválida do servidor (HTTP " + resp.status + ").");
      }).then(function (data) {
        if (!resp.ok || !data || data.ok === false) {
          var msg = (data && data.error) ? data.error : ("Erro do servidor (HTTP " + resp.status + ").");
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  function errorMessageFrom(err) {
    if (err && err.message) {
      if (err.message === "Failed to fetch" || err.message.indexOf("NetworkError") !== -1) {
        return "Não foi possível conectar ao servidor de análise. Verifique a conexão e tente novamente.";
      }
      return err.message;
    }
    return "Ocorreu um erro inesperado ao analisar a imagem.";
  }

  /* -----------------------------------------------------------------------
     Aplicação do resultado (comum a imagem e câmera)
     ------------------------------------------------------------------- */

  function applyPredictionResult(data) {
    state.naturalWidth = data.width;
    state.naturalHeight = data.height;
    state.lastDetections = data.detections || [];
    state.lastCounts = data.counts || {};

    updateInferenceBadge(data.inference_ms);
    updateInfectionRate(data.infection_rate_pct);
    renderChips(state.lastCounts);
    redrawOverlay();
  }

  // Faixas de latência do badge de inferência — sinal semântico rápido/
  // médio/lento, reforçando a leitura de "instrumento medindo desempenho
  // em tempo real" (sem depender de glow ou cor única neutra).
  var INFERENCE_FAST_MS = 150;
  var INFERENCE_SLOW_MS = 400;

  function updateInferenceBadge(ms) {
    if (typeof ms !== "number") {
      els.badgeInference.hidden = true;
      return;
    }
    els.badgeInference.hidden = false;
    els.badgeInference.classList.remove("badge-fast", "badge-slow");
    if (ms <= INFERENCE_FAST_MS) {
      els.badgeInference.classList.add("badge-fast");
    } else if (ms >= INFERENCE_SLOW_MS) {
      els.badgeInference.classList.add("badge-slow");
    }
    els.badgeInferenceValue.textContent = Math.round(ms) + "ms";
  }

  var INFECTION_RATE_ANIM_MS = 380;
  var infectionRateAnimFrame = null;
  var infectionRateDisplayed = 0;

  function updateInfectionRate(pct) {
    els.infectionRate.classList.remove("rate-high", "rate-medium");

    if (infectionRateAnimFrame) {
      window.cancelAnimationFrame(infectionRateAnimFrame);
      infectionRateAnimFrame = null;
    }

    if (pct === null || pct === undefined || isNaN(pct)) {
      infectionRateDisplayed = 0;
      els.infectionRate.textContent = "N/A";
      setInfectionSeverity(null);
      setInfectionGaugePosition(0);
      return;
    }

    if (pct >= 10) {
      els.infectionRate.classList.add("rate-high");
      setInfectionSeverity("high");
    } else if (pct >= 2) {
      els.infectionRate.classList.add("rate-medium");
      setInfectionSeverity("medium");
    } else {
      setInfectionSeverity("low");
    }

    setInfectionGaugePosition(pct);
    animateInfectionRateTo(pct);
  }

  // Count-up curto (~380ms) em vez de troca instantânea de textContent —
  // reforça a sensação de instrumento medindo, não de campo recarregando.
  function animateInfectionRateTo(target) {
    var start = infectionRateDisplayed;
    var startTime = null;

    function step(timestamp) {
      if (startTime === null) startTime = timestamp;
      var elapsed = timestamp - startTime;
      var t = Math.min(1, elapsed / INFECTION_RATE_ANIM_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      var value = start + (target - start) * eased;
      els.infectionRate.textContent = formatPct(value) + "%";
      if (t < 1) {
        infectionRateAnimFrame = window.requestAnimationFrame(step);
      } else {
        infectionRateDisplayed = target;
        infectionRateAnimFrame = null;
      }
    }

    if (window.requestAnimationFrame) {
      infectionRateAnimFrame = window.requestAnimationFrame(step);
    } else {
      infectionRateDisplayed = target;
      els.infectionRate.textContent = formatPct(target) + "%";
    }
  }

  var SEVERITY_LABELS_PT = { low: "Baixo", medium: "Moderado", high: "Alto" };

  function setInfectionSeverity(level) {
    if (!els.infectionSeverity) return;
    els.infectionSeverity.classList.remove("severity-low", "severity-medium", "severity-high");
    if (!level) {
      els.infectionSeverity.textContent = "—";
      return;
    }
    els.infectionSeverity.classList.add("severity-" + level);
    els.infectionSeverity.textContent = SEVERITY_LABELS_PT[level];
  }

  // Posição do marcador na barra de gradiente verde→âmbar→vermelho — leitura
  // instantânea à distância no estande, complementar ao número e à cor do texto.
  function setInfectionGaugePosition(pct) {
    if (!els.infectionGaugeMarker) return;
    var clamped = clampNum(pct / 20 * 100, 0, 100);
    els.infectionGaugeMarker.style.left = clamped + "%";
  }

  function formatPct(pct) {
    var rounded = Math.round(pct * 100) / 100;
    return String(rounded).replace(".", ",");
  }

  /* -----------------------------------------------------------------------
     Desenho das detecções no canvas overlay
     ------------------------------------------------------------------- */

  function getActiveMediaEl() {
    return state.mode === "camera" ? els.cameraVideo : els.resultImage;
  }

  function clearCanvas() {
    var canvas = els.overlayCanvas;
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  // A mídia usa object-fit: contain — calcula a área real ocupada dentro do
  // palco, para converter coordenadas naturais da imagem <-> coordenadas de tela.
  // Compartilhado entre a tela de análise (overlay de detecção) e a de
  // anotação do especialista (desenho de caixas).
  function computeContainLayout(naturalW, naturalH, displayW, displayH) {
    if (!naturalW || !naturalH || !displayW || !displayH) return null;

    var mediaRatio = naturalW / naturalH;
    var boxRatio = displayW / displayH;
    var renderW, renderH, offsetX, offsetY;

    if (mediaRatio > boxRatio) {
      renderW = displayW;
      renderH = displayW / mediaRatio;
      offsetX = 0;
      offsetY = (displayH - renderH) / 2;
    } else {
      renderH = displayH;
      renderW = displayH * mediaRatio;
      offsetY = 0;
      offsetX = (displayW - renderW) / 2;
    }

    return {
      offsetX: offsetX, offsetY: offsetY,
      scaleX: renderW / naturalW, scaleY: renderH / naturalH
    };
  }

  function redrawOverlay() {
    var mediaEl = getActiveMediaEl();
    if (!mediaEl || mediaEl.hidden) return;

    var displayW = mediaEl.clientWidth;
    var displayH = mediaEl.clientHeight;
    if (!displayW || !displayH) return;

    var canvas = els.overlayCanvas;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(displayW * dpr);
    canvas.height = Math.round(displayH * dpr);
    canvas.style.width = displayW + "px";
    canvas.style.height = displayH + "px";

    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, displayW, displayH);

    var layout = computeContainLayout(state.naturalWidth, state.naturalHeight, displayW, displayH);
    if (!layout) return;

    var byClass = {};
    state.lastDetections.forEach(function (det) {
      (byClass[det.class_name] = byClass[det.class_name] || []).push(det);
    });

    DRAW_ORDER.forEach(function (className) {
      if (className === "red blood cell" && !state.showRBC) return;
      var list = byClass[className];
      if (!list) return;
      list.forEach(function (det) {
        drawBox(ctx, det, layout.offsetX, layout.offsetY, layout.scaleX, layout.scaleY);
      });
    });
  }

  function drawBox(ctx, det, offsetX, offsetY, scaleX, scaleY) {
    var box = det.box || [0, 0, 0, 0];
    var x1 = offsetX + box[0] * scaleX;
    var y1 = offsetY + box[1] * scaleY;
    var x2 = offsetX + box[2] * scaleX;
    var y2 = offsetY + box[3] * scaleY;
    var w = x2 - x1;
    var h = y2 - y1;

    var color = CLASS_COLORS[det.class_name] || "#5B93FF";
    var isDifficult = det.class_name === "difficult";
    var isSelected = state.selectedClass === det.class_name;

    ctx.save();
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.strokeStyle = color;
    if (isDifficult) {
      ctx.setLineDash([6, 4]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.strokeRect(x1, y1, w, h);
    ctx.restore();

    var label = CLASS_LABELS_PT[det.class_name] || det.class_name;
    if (typeof det.confidence === "number") {
      label += " " + Math.round(det.confidence * 100) + "%";
    }

    ctx.save();
    ctx.font = "600 12px 'IBM Plex Sans', system-ui, sans-serif";
    var textW = ctx.measureText(label).width;
    var padX = 6;
    var labelH = 18;
    var labelY = y1 - labelH >= 0 ? y1 - labelH : y1;
    var labelW = textW + padX * 2;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.94;
    roundedRectPath(ctx, x1, labelY, labelW, labelH, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = labelTextColorFor(color);
    ctx.fillText(label, x1 + padX, labelY + labelH - 5.5);
    ctx.restore();
  }

  // Caminho de retângulo com cantos arredondados — usado no rótulo das
  // detecções em vez de um retângulo sólido, sem depender de
  // CanvasRenderingContext2D.roundRect (ausente em navegadores mais antigos).
  function roundedRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Cor do texto do rótulo escolhida dinamicamente pelo contraste da cor de
  // classe (WCAG luminância relativa), em vez de um "#0a0f14" fixo — melhora
  // a legibilidade em classes com preenchimento mais saturado/escuro
  // (ex.: schizont roxo, gametocyte azul).
  function labelTextColorFor(hex) {
    return relativeLuminance(hex) > 0.5 ? "#0b1220" : "#ffffff";
  }

  function relativeLuminance(hex) {
    hex = String(hex).replace("#", "");
    if (hex.length === 3) {
      hex = hex.split("").map(function (c) { return c + c; }).join("");
    }
    var num = parseInt(hex, 16);
    var r = (num >> 16) & 255;
    var g = (num >> 8) & 255;
    var b = num & 255;
    var channels = [r, g, b].map(function (v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /* -----------------------------------------------------------------------
     Zoom/pan estilo microscópio sobre a mídia analisada
     A camada #zoom-layer (imagem/vídeo + canvas juntos) recebe um
     transform CSS puramente visual — clientWidth/clientHeight da mídia
     não mudam, então redrawOverlay() continua funcionando sem alterações.
     ------------------------------------------------------------------- */

  var zoomActivePointers = {};
  var zoomActiveCount = 0;
  var zoomDragState = null;
  var zoomPinchState = null;
  var zoomGestureMoved = false;
  var zoomLastTapTime = 0;
  var zoomSuppressNextDblClick = false;

  function clampNum(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function isZoomInteractable() {
    var el = getActiveMediaEl();
    return !!el && !el.hidden && els.stagePlaceholder.hidden && els.stageError.hidden;
  }

  function applyZoomTransform(animate) {
    els.zoomLayer.style.transition = animate ? "transform 0.28s var(--ease)" : "none";
    els.zoomLayer.style.transform =
      "translate(" + state.zoom.tx + "px, " + state.zoom.ty + "px) scale(" + state.zoom.scale + ")";
  }

  function updateZoomUI() {
    var zoomed = state.zoom.scale > 1.02;
    els.zoomControls.hidden = !zoomed;
    els.zoomBadge.textContent = state.zoom.scale.toFixed(1).replace(".", ",") + "x";
  }

  function clampPan() {
    var w = els.mediaStage.clientWidth;
    var h = els.mediaStage.clientHeight;
    var s = state.zoom.scale;
    state.zoom.tx = clampNum(state.zoom.tx, w * (1 - s), 0);
    state.zoom.ty = clampNum(state.zoom.ty, h * (1 - s), 0);
  }

  function resetZoom(animate) {
    state.zoom.scale = 1;
    state.zoom.tx = 0;
    state.zoom.ty = 0;
    applyZoomTransform(!!animate);
    updateZoomUI();
  }

  // Aplica um novo nível de zoom mantendo o ponto (px, py) — em coordenadas
  // locais do #media-stage — fixo na tela (zoom "sob o cursor/dedos").
  function zoomAt(px, py, newScale, animate) {
    newScale = clampNum(newScale, ZOOM_MIN, ZOOM_MAX);
    var s0 = state.zoom.scale;
    if (Math.abs(newScale - s0) < 0.001 && newScale !== ZOOM_MIN) return;

    state.zoom.tx = px - (newScale / s0) * (px - state.zoom.tx);
    state.zoom.ty = py - (newScale / s0) * (py - state.zoom.ty);
    state.zoom.scale = newScale;
    clampPan();
    applyZoomTransform(!!animate);
    updateZoomUI();
  }

  function stageLocalPoint(clientX, clientY) {
    var rect = els.mediaStage.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function pointerDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointerMid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function onZoomPointerDown(e) {
    if (!isZoomInteractable()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    // Não capturar o ponteiro quando o gesto começa nos controles de zoom
    // (o botão de reset), senão o clique nele nunca chega a disparar.
    if (e.target.closest("#zoom-controls")) return;

    els.mediaStage.setPointerCapture(e.pointerId);
    zoomActivePointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    zoomActiveCount++;
    zoomGestureMoved = false;

    if (zoomActiveCount === 1) {
      zoomDragState = { startX: e.clientX, startY: e.clientY, startTx: state.zoom.tx, startTy: state.zoom.ty };
      zoomPinchState = null;
      els.mediaStage.classList.add("zoom-dragging");
    } else if (zoomActiveCount === 2) {
      zoomDragState = null;
      var pts = pointerValues();
      var local = stageLocalPoint(pointerMid(pts[0], pts[1]).x, pointerMid(pts[0], pts[1]).y);
      zoomPinchState = {
        startDist: pointerDist(pts[0], pts[1]) || 1,
        startScale: state.zoom.scale,
        startTx: state.zoom.tx,
        startTy: state.zoom.ty,
        localX: local.x,
        localY: local.y
      };
    }
  }

  function pointerValues() {
    return Object.keys(zoomActivePointers).map(function (id) { return zoomActivePointers[id]; });
  }

  function onZoomPointerMove(e) {
    if (!zoomActivePointers[e.pointerId]) return;
    zoomActivePointers[e.pointerId] = { x: e.clientX, y: e.clientY };

    if (zoomActiveCount === 1 && zoomDragState) {
      var dx = e.clientX - zoomDragState.startX;
      var dy = e.clientY - zoomDragState.startY;
      if (Math.hypot(dx, dy) > TAP_MOVE_THRESHOLD) zoomGestureMoved = true;
      state.zoom.tx = zoomDragState.startTx + dx;
      state.zoom.ty = zoomDragState.startTy + dy;
      clampPan();
      applyZoomTransform(false);
    } else if (zoomActiveCount === 2 && zoomPinchState) {
      zoomGestureMoved = true;
      var pts = pointerValues();
      var dist = pointerDist(pts[0], pts[1]) || 1;
      var ratio = dist / zoomPinchState.startDist;
      var newScale = clampNum(zoomPinchState.startScale * ratio, ZOOM_MIN, ZOOM_MAX);
      var s0 = zoomPinchState.startScale;
      state.zoom.scale = newScale;
      state.zoom.tx = zoomPinchState.localX - (newScale / s0) * (zoomPinchState.localX - zoomPinchState.startTx);
      state.zoom.ty = zoomPinchState.localY - (newScale / s0) * (zoomPinchState.localY - zoomPinchState.startTy);
      clampPan();
      applyZoomTransform(false);
      updateZoomUI();
    }
  }

  function onZoomPointerUp(e) {
    if (!zoomActivePointers[e.pointerId]) return;
    var wasTouch = e.pointerType === "touch" && !zoomGestureMoved && zoomActiveCount === 1;
    delete zoomActivePointers[e.pointerId];
    zoomActiveCount = Math.max(0, zoomActiveCount - 1);

    if (zoomActiveCount === 0) {
      zoomDragState = null;
      zoomPinchState = null;
      els.mediaStage.classList.remove("zoom-dragging");

      if (wasTouch) {
        var now = Date.now();
        if (zoomLastTapTime && now - zoomLastTapTime < DOUBLE_TAP_MS) {
          zoomLastTapTime = 0;
          zoomSuppressNextDblClick = true;
          window.setTimeout(function () { zoomSuppressNextDblClick = false; }, 400);
          var local = stageLocalPoint(e.clientX, e.clientY);
          zoomAt(local.x, local.y, state.zoom.scale > 1.02 ? ZOOM_MIN : ZOOM_DOUBLE_TAP, true);
        } else {
          zoomLastTapTime = now;
        }
      }
    } else if (zoomActiveCount === 1) {
      // Volta de dois dedos (pinça) para um dedo só (arraste) sem soltar.
      var remaining = pointerValues()[0];
      zoomDragState = { startX: remaining.x, startY: remaining.y, startTx: state.zoom.tx, startTy: state.zoom.ty };
      zoomPinchState = null;
    }
  }

  function onZoomWheel(e) {
    if (!isZoomInteractable()) return;
    e.preventDefault();
    var local = stageLocalPoint(e.clientX, e.clientY);
    var factor = Math.exp(-e.deltaY * 0.0015);
    zoomAt(local.x, local.y, state.zoom.scale * factor, false);
  }

  function onZoomDoubleClick(e) {
    // Em alguns navegadores um duplo-toque também sintetiza um "dblclick" —
    // se o duplo-toque manual (pointerup) já tratou o zoom, ignora este.
    if (zoomSuppressNextDblClick) {
      zoomSuppressNextDblClick = false;
      return;
    }
    if (!isZoomInteractable()) return;
    var local = stageLocalPoint(e.clientX, e.clientY);
    zoomAt(local.x, local.y, state.zoom.scale > 1.02 ? ZOOM_MIN : ZOOM_DOUBLE_TAP, true);
  }

  function showZoomHint() {
    els.zoomHint.hidden = false;
    els.zoomHint.classList.remove("zoom-hint-fade");
    // força reflow para reiniciar a transição caso o hint já estivesse visível
    void els.zoomHint.offsetWidth;
    window.setTimeout(function () {
      els.zoomHint.classList.add("zoom-hint-fade");
    }, 3200);
  }

  function setupZoomInteractions() {
    // Backstop para navegadores que ignoram draggable="false"/-webkit-user-drag:
    // sem isso, um arrasto iniciado sobre a <img> pode virar um "arrastar
    // imagem" nativo e cancelar o gesto de pan/zoom no meio do caminho.
    els.mediaStage.addEventListener("dragstart", function (e) { e.preventDefault(); });
    els.mediaStage.addEventListener("pointerdown", onZoomPointerDown);
    els.mediaStage.addEventListener("pointermove", onZoomPointerMove);
    els.mediaStage.addEventListener("pointerup", onZoomPointerUp);
    els.mediaStage.addEventListener("pointercancel", onZoomPointerUp);
    els.mediaStage.addEventListener("wheel", onZoomWheel, { passive: false });
    els.mediaStage.addEventListener("dblclick", onZoomDoubleClick);
    els.zoomHint.addEventListener("transitionend", function () {
      if (els.zoomHint.classList.contains("zoom-hint-fade")) els.zoomHint.hidden = true;
    });
    els.btnZoomReset.addEventListener("click", function (e) {
      e.stopPropagation();
      resetZoom(true);
    });
  }

  /* -----------------------------------------------------------------------
     Painel de chips por classe
     ------------------------------------------------------------------- */

  function renderChips(counts) {
    els.chipsContainer.innerHTML = "";

    var entries = Object.keys(counts || {})
      .map(function (name) { return { name: name, count: counts[name] || 0 }; })
      .filter(function (e) { return e.count > 0; })
      .sort(function (a, b) { return b.count - a.count; });

    if (entries.length === 0) {
      var empty = document.createElement("p");
      empty.className = "chips-empty";
      empty.textContent = "Nenhuma detecção com o limiar de confiança atual.";
      els.chipsContainer.appendChild(empty);
      return;
    }

    entries.forEach(function (entry) {
      var color = CLASS_COLORS[entry.name] || "#5B93FF";
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.setProperty("--chip-color", color);
      if (state.selectedClass === entry.name) chip.classList.add("chip-selected");

      var dot = document.createElement("span");
      dot.className = "chip-dot";

      var label = document.createElement("span");
      label.textContent = CLASS_LABELS_PT[entry.name] || entry.name;

      var count = document.createElement("span");
      count.className = "chip-count";
      count.textContent = entry.count;

      chip.appendChild(dot);
      chip.appendChild(label);
      chip.appendChild(count);

      chip.addEventListener("click", function () {
        selectClass(entry.name);
      });

      els.chipsContainer.appendChild(chip);
    });
  }

  function selectClass(className) {
    state.selectedClass = (state.selectedClass === className) ? null : className;
    renderChips(state.lastCounts);
    renderDescription();
    redrawOverlay();
  }

  function renderDescription() {
    if (!state.selectedClass) {
      resetDescription();
      return;
    }
    var name = state.selectedClass;
    var color = CLASS_COLORS[name] || "#5B93FF";
    var label = CLASS_LABELS_PT[name] || name;
    var text = CLASS_DESCRIPTIONS_PT[name] || "";

    els.descriptionCard.innerHTML = "";

    var title = document.createElement("div");
    title.className = "description-title";

    var dot = document.createElement("span");
    dot.className = "chip-dot";
    dot.style.setProperty("--chip-color", color);
    dot.style.background = color;

    var titleText = document.createElement("span");
    titleText.textContent = label;

    title.appendChild(dot);
    title.appendChild(titleText);

    var body = document.createElement("p");
    body.className = "description-text";
    body.textContent = text;

    els.descriptionCard.appendChild(title);
    els.descriptionCard.appendChild(body);
  }

  function resetDescription() {
    els.descriptionCard.innerHTML = '<p class="description-placeholder">Toque em uma classe acima para saber mais sobre ela.</p>';
  }

  /* -----------------------------------------------------------------------
     Controles do painel: toggle hemácias, slider de confiança
     ------------------------------------------------------------------- */

  function setupResultControls() {
    els.toggleRBC.addEventListener("change", function () {
      state.showRBC = els.toggleRBC.checked;
      redrawOverlay();
    });

    var debounceTimer = null;
    els.confSlider.addEventListener("input", function () {
      var val = parseFloat(els.confSlider.value);
      state.confidence = val;
      els.confValue.textContent = val.toFixed(2);

      if (state.mode === "camera") return; // próximo tick da câmera já usa o novo valor

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        if (state.lastPayload) {
          showStagePlaceholderSubtle();
          runPredictForImage();
        }
      }, 300);
    });
  }

  function showStagePlaceholderSubtle() {
    // Reanálise por causa do slider: não bloquear a visualização com overlay grande,
    // apenas indicar no badge de inferência que está processando.
    els.badgeInference.hidden = false;
    els.badgeInference.classList.remove("badge-fast", "badge-slow");
    els.badgeInferenceValue.textContent = "analisando…";
  }

  /* -----------------------------------------------------------------------
     Redesenho responsivo ao redimensionar a janela
     ------------------------------------------------------------------- */

  function setupResize() {
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        redrawOverlay();
        redrawAnnotateCanvas();
      }, 100);
    });

    els.resultImage.addEventListener("load", redrawOverlay);
    els.cameraVideo.addEventListener("loadedmetadata", redrawOverlay);
  }

  /* -----------------------------------------------------------------------
     Botões de navegação
     ------------------------------------------------------------------- */

  function setupNavigation() {
    els.btnCamera.addEventListener("click", startCameraFlow);
    els.btnUpload.addEventListener("click", goToUpload);
    els.btnUploadBack.addEventListener("click", goHome);
    els.btnNewAnalysis.addEventListener("click", goHome);
    els.btnStageErrorBack.addEventListener("click", goHome);
  }

  /* -----------------------------------------------------------------------
     Inicialização
     ------------------------------------------------------------------- */

  function init() {
    cacheEls();
    setupNavigation();
    setupUpload();
    setupBatchUpload();
    setupResultControls();
    setupAnnotateInteractions();
    setupReportControls();
    setupResize();
    setupZoomInteractions();
    loadSamples();
    showView("home");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

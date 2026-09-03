const worktree = { type: "string", description: "Nome da worktree, por exemplo t_a74adce7." };
const string = (description) => ({ type: "string", description });
const integer = (description, minimum = undefined, maximum = undefined) => ({
  type: "integer",
  description,
  ...(minimum !== undefined ? { minimum } : {}),
  ...(maximum !== undefined ? { maximum } : {}),
});

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

const deliveryMode = { type: "string", enum: ["background", "foreground"], description: "Use background por padrao; foreground apenas como escalacao quando necessario." };

export function buildTools() {
  return [
    tool("gwrm_status", "Mostra o estado geral do GWRM, Computer Use e todas as worktrees registradas."),
    tool("activate_worktree", "Marca uma worktree como ativa e aguarda Godot headless/LSP e Godot MCP dedicado ficarem prontos.", { worktree_name: worktree }, ["worktree_name"]),
    tool("deactivate_worktree", "Marca uma worktree como inativa e encerra seus servicos.", { worktree_name: worktree }, ["worktree_name"]),
    tool("get_worktree_status", "Mostra processos, portas e estado de uma worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_gut_tests", "Inicia uma execucao GUT supervisionada por diretorio e retorna imediatamente operation_id. Consulte get_gut_run_status ate terminal=true.", {
      worktree_name: worktree,
      test_directory: string("Diretorio res:// dentro da raiz de testes permitida."),
    }, ["worktree_name"]),
    tool("run_gut_test_script", "Inicia uma execucao GUT supervisionada de um unico script e retorna imediatamente operation_id. Consulte get_gut_run_status ate terminal=true.", {
      worktree_name: worktree,
      test_script: string("Caminho res:// completo do script de teste."),
    }, ["worktree_name", "test_script"]),
    tool("get_gut_run_status", "Consulta uma execucao GUT supervisionada. Quando terminal=true, result contem o resultado final ou error descreve a falha.", {
      operation_id: string("operation_id retornado por run_gut_tests ou run_gut_test_script."),
    }, ["operation_id"]),
    tool("launch_editor", "Encaminha launch_editor ao Godot MCP dedicado da worktree. Pode abrir um editor visual adicional.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_project", "Executa o projeto/cena graficamente pelo Godot MCP dedicado da worktree.", { worktree_name: worktree, scene: string("Cena opcional relativa ao projeto.") }, ["worktree_name"]),
    tool("get_debug_output", "Retorna a saida do run_project pertencente somente a esta worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("stop_project", "Encerra somente o run_project controlado pelo Godot MCP dedicado desta worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("get_godot_version", "Retorna a versao do Godot atraves do MCP dedicado da worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("list_projects", "Lista projetos a partir da raiz da worktree indicada.", { worktree_name: worktree, recursive: { type: "boolean" } }, ["worktree_name"]),
    tool("get_project_info", "Retorna informacoes do projeto Godot da worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("create_scene", "Cria uma cena no projeto da worktree.", {
      worktree_name: worktree,
      scene_path: string("Caminho da cena relativo ao projeto."),
      root_node_type: string("Tipo do no raiz; padrao Node2D."),
    }, ["worktree_name", "scene_path"]),
    tool("add_node", "Adiciona um no a uma cena da worktree.", {
      worktree_name: worktree,
      scene_path: string("Cena relativa ao projeto."),
      parent_node_path: string("Caminho opcional do no pai."),
      node_type: string("Tipo do no Godot."),
      node_name: string("Nome do novo no."),
      properties: { type: "object", description: "Propriedades opcionais." },
    }, ["worktree_name", "scene_path", "node_type", "node_name"]),
    tool("load_sprite", "Carrega uma textura em um Sprite2D de uma cena da worktree.", {
      worktree_name: worktree,
      scene_path: string("Cena relativa ao projeto."),
      node_path: string("Caminho do Sprite2D."),
      texture_path: string("Textura relativa ao projeto."),
    }, ["worktree_name", "scene_path", "node_path", "texture_path"]),
    tool("export_mesh_library", "Exporta uma cena da worktree como MeshLibrary.", {
      worktree_name: worktree,
      scene_path: string("Cena .tscn relativa ao projeto."),
      output_path: string("Destino .res."),
      mesh_item_names: { type: "array", items: { type: "string" } },
    }, ["worktree_name", "scene_path", "output_path"]),
    tool("save_scene", "Salva uma cena da worktree, opcionalmente em novo caminho.", {
      worktree_name: worktree,
      scene_path: string("Cena relativa ao projeto."),
      new_path: string("Novo caminho opcional."),
    }, ["worktree_name", "scene_path"]),
    tool("get_uid", "Retorna o UID de um arquivo da worktree.", { worktree_name: worktree, file_path: string("Arquivo relativo ao projeto.") }, ["worktree_name", "file_path"]),
    tool("update_project_uids", "Regrava recursos para atualizar UIDs no projeto da worktree.", { worktree_name: worktree }, ["worktree_name"]),

    tool("gui_status", "Mostra o estado do Computer Use/Cua Driver supervisionado pelo GWRM."),
    tool("gui_list_windows", "Lista somente janelas Godot graficas autorizadas que pertencem a processos associados a worktree.", {
      worktree_name: worktree,
      on_screen_only: { type: "boolean", description: "Quando true, retorna apenas janelas atualmente on-screen." },
    }, ["worktree_name"]),
    tool("gui_wait_for_window", "Aguarda internamente uma janela Godot grafica da worktree, evitando polling pelo agente.", {
      worktree_name: worktree,
      title_contains: string("Filtro opcional por substring do titulo."),
      on_screen_only: { type: "boolean" },
      timeout_seconds: integer("Timeout interno.", 1, 300),
    }, ["worktree_name"]),
    tool("gui_inspect_window", "Inspeciona semanticamente uma janela. Por padrao NAO captura screenshot, economizando tokens de imagem.", {
      worktree_name: worktree,
      window_id: integer("window_id retornado por gui_list_windows/gui_wait_for_window.", 1),
      query: string("Filtro textual opcional para reduzir a arvore de acessibilidade."),
      max_elements: integer("Limite da arvore semantica.", 1, 2000),
      max_depth: integer("Profundidade maxima.", 1, 25),
    }, ["worktree_name", "window_id"]),
    tool("gui_capture_window", "Captura visual sob demanda de uma janela autorizada. Use apenas quando a inspecao semantica nao bastar.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      max_dimension: integer("Limite da maior dimensao da imagem.", 64, 4096),
    }, ["worktree_name", "window_id"]),
    tool("gui_wait_for_element", "Aguarda internamente um elemento semantico aparecer na janela, sem screenshot e sem polling pelo agente.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      query: string("Texto/label a procurar na arvore de acessibilidade."),
      timeout_seconds: integer("Timeout interno.", 1, 300),
      max_elements: integer("Limite da arvore semantica.", 1, 2000),
      max_depth: integer("Profundidade maxima.", 1, 25),
    }, ["worktree_name", "window_id", "query"]),
    tool("gui_click", "Clica em elemento semantico ou coordenada local da janela. Background e o modo padrao.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      element_token: string("Token opaco retornado por gui_inspect_window; preferido."),
      element_index: integer("Indice do elemento da snapshot.", 0),
      snapshot_id: string("Snapshot correspondente ao element_index."),
      x: { type: "number" }, y: { type: "number" },
      button: { type: "string", enum: ["left", "right", "middle"] },
      count: integer("Quantidade de cliques.", 1, 10),
      action: string("Acao AX opcional: press, show_menu, pick, confirm, cancel, open."),
      modifier: { type: "array", items: { type: "string" } },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id"]),
    tool("gui_type_text", "Insere texto em elemento/campo da janela autorizada.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      text: string("Texto a inserir."),
      element_token: string("Token semantico preferido."),
      element_index: integer("Indice do elemento.", 0),
      snapshot_id: string("Snapshot correspondente."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "text"]),
    tool("gui_press_key", "Pressiona uma tecla na janela autorizada.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      key: string("Tecla: return, tab, escape, space, setas, letras etc."),
      modifiers: { type: "array", items: { type: "string" } },
      element_token: string("Token semantico opcional."),
      element_index: integer("Indice do elemento.", 0),
      snapshot_id: string("Snapshot correspondente."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "key"]),
    tool("gui_hotkey", "Envia um atalho de teclado para a janela autorizada.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      keys: { type: "array", minItems: 2, items: { type: "string" } },
      element_token: string("Token semantico opcional."),
      element_index: integer("Indice do elemento.", 0),
      snapshot_id: string("Snapshot correspondente."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "keys"]),
    tool("gui_scroll", "Rola a janela ou elemento autorizado.", {
      worktree_name: worktree,
      window_id: integer("window_id autorizado.", 1),
      direction: { type: "string", enum: ["up", "down", "left", "right"] },
      amount: integer("Quantidade de passos/notches.", 1, 50),
      by: { type: "string", enum: ["line", "page"] },
      element_token: string("Token semantico opcional."),
      element_index: integer("Indice do elemento.", 0),
      snapshot_id: string("Snapshot correspondente."),
      x: { type: "number" }, y: { type: "number" },
      delivery_mode: deliveryMode,
    }, ["worktree_name", "window_id", "direction"]),
  ];
}

const GODOT_TOOLS = new Set([
  "launch_editor", "run_project", "get_debug_output", "stop_project", "get_godot_version", "list_projects", "get_project_info",
  "create_scene", "add_node", "load_sprite", "export_mesh_library", "save_scene", "get_uid", "update_project_uids",
]);

export function buildToolHandler(config, sessionManager, gutRunner, computerUse) {
  return async (name, args) => {
    if (name === "gwrm_status") return {
      ready: true,
      service: config.service.name,
      version: "1.1.0",
      config_file: config.configPath,
      reconciliation_interval_seconds: config.service.reconciliationIntervalSeconds,
      max_active_worktrees: config.service.maxActiveWorktrees,
      computer_use: computerUse.getStatus(),
      worktrees: sessionManager.listStatuses(),
    };
    if (name === "activate_worktree") return await sessionManager.activateWorktree(args.worktree_name, "mcp");
    if (name === "deactivate_worktree") return await sessionManager.deactivateWorktree(args.worktree_name, "mcp");
    if (name === "get_worktree_status") return sessionManager.getStatus(args.worktree_name);
    if (name === "run_gut_tests") return gutRunner.startDirectory(args.worktree_name, args.test_directory);
    if (name === "run_gut_test_script") return gutRunner.startScript(args.worktree_name, args.test_script);
    if (name === "get_gut_run_status") return gutRunner.getOperation(args.operation_id);
    if (GODOT_TOOLS.has(name)) return await sessionManager.callGodotTool(args.worktree_name, name, args);

    if (name === "gui_status") return computerUse.getStatus();
    if (name === "gui_list_windows") return await computerUse.listWindows(args.worktree_name, { onScreenOnly: args.on_screen_only });
    if (name === "gui_wait_for_window") return await computerUse.waitForWindow(args.worktree_name, {
      titleContains: args.title_contains,
      onScreenOnly: args.on_screen_only,
      timeoutSeconds: args.timeout_seconds,
    });
    if (name === "gui_inspect_window") return await computerUse.inspectWindow(args.worktree_name, args.window_id, {
      query: args.query,
      maxElements: args.max_elements,
      maxDepth: args.max_depth,
    });
    if (name === "gui_capture_window") return await computerUse.captureWindow(args.worktree_name, args.window_id, { maxDimension: args.max_dimension });
    if (name === "gui_wait_for_element") return await computerUse.waitForElement(args.worktree_name, args.window_id, args.query, {
      timeoutSeconds: args.timeout_seconds,
      maxElements: args.max_elements,
      maxDepth: args.max_depth,
    });
    if (name === "gui_click") return await computerUse.click(args.worktree_name, args.window_id, args);
    if (name === "gui_type_text") return await computerUse.typeText(args.worktree_name, args.window_id, args);
    if (name === "gui_press_key") return await computerUse.pressKey(args.worktree_name, args.window_id, args);
    if (name === "gui_hotkey") return await computerUse.hotkey(args.worktree_name, args.window_id, args);
    if (name === "gui_scroll") return await computerUse.scroll(args.worktree_name, args.window_id, args);
    throw new Error(`Tool desconhecida: ${name}`);
  };
}

const worktree = { type: "string", description: "Nome da worktree, por exemplo t_a74adce7." };
const string = (description) => ({ type: "string", description });

function tool(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } };
}

export function buildTools() {
  return [
    tool("gwrm_status", "Mostra o estado geral do GWRM e todas as worktrees registradas."),
    tool("activate_worktree", "Marca uma worktree como ativa e aguarda Godot headless/LSP e Godot MCP dedicado ficarem prontos.", { worktree_name: worktree }, ["worktree_name"]),
    tool("deactivate_worktree", "Marca uma worktree como inativa e encerra seus servicos.", { worktree_name: worktree }, ["worktree_name"]),
    tool("get_worktree_status", "Mostra processos, portas e estado de uma worktree.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_gut_tests", "Executa testes GUT por diretorio no projeto da worktree. Valida contagens, falhas, erros e class_name.", {
      worktree_name: worktree,
      test_directory: string("Diretorio res:// dentro da raiz de testes permitida."),
    }, ["worktree_name"]),
    tool("run_gut_test_script", "Executa um unico script GUT no projeto da worktree.", {
      worktree_name: worktree,
      test_script: string("Caminho res:// completo do script de teste."),
    }, ["worktree_name", "test_script"]),
    tool("launch_editor", "Encaminha launch_editor ao Godot MCP dedicado da worktree. Pode abrir um editor visual adicional.", { worktree_name: worktree }, ["worktree_name"]),
    tool("run_project", "Executa o projeto da worktree pelo Godot MCP dedicado.", { worktree_name: worktree, scene: string("Cena opcional relativa ao projeto.") }, ["worktree_name"]),
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
  ];
}

const GODOT_TOOLS = new Set([
  "launch_editor", "run_project", "get_debug_output", "stop_project", "get_godot_version", "list_projects", "get_project_info",
  "create_scene", "add_node", "load_sprite", "export_mesh_library", "save_scene", "get_uid", "update_project_uids",
]);

export function buildToolHandler(config, sessionManager, gutRunner) {
  return async (name, args) => {
    if (name === "gwrm_status") return {
      ready: true,
      service: config.service.name,
      version: "1.0.0",
      config_file: config.configPath,
      reconciliation_interval_seconds: config.service.reconciliationIntervalSeconds,
      max_active_worktrees: config.service.maxActiveWorktrees,
      worktrees: sessionManager.listStatuses(),
    };
    if (name === "activate_worktree") return await sessionManager.activateWorktree(args.worktree_name, "mcp");
    if (name === "deactivate_worktree") return await sessionManager.deactivateWorktree(args.worktree_name, "mcp");
    if (name === "get_worktree_status") {
      const status = sessionManager.getStatus(args.worktree_name);
      if (!status) throw new Error(`Worktree nao registrada: ${args.worktree_name}`);
      return status;
    }
    if (name === "run_gut_tests") return await gutRunner.runDirectory(args.worktree_name, args.test_directory);
    if (name === "run_gut_test_script") return await gutRunner.runScript(args.worktree_name, args.test_script);
    if (GODOT_TOOLS.has(name)) return await sessionManager.callGodotTool(args.worktree_name, name, args);
    throw new Error(`Tool desconhecida: ${name}`);
  };
}

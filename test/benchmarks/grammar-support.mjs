/**
 * Grammar Support: Tree-Sitter Language Verification
 * 
 * Parses code samples with all 9 supported language grammars.
 * Validates AST node extraction and measures parse speed.
 * 
 * Usage: node test/benchmarks/grammar-support.mjs
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Load tree-sitter
const Parser = require('tree-sitter');

const c = {
    green: (s) => `\x1b[32m${s}\x1b[0m`,
    red: (s) => `\x1b[31m${s}\x1b[0m`,
    dim: (s) => `\x1b[2m${s}\x1b[0m`,
    bold: (s) => `\x1b[1m${s}\x1b[0m`,
    cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

const TESTS = [
    {
        lang: 'typescript',
        grammar: () => require('tree-sitter-typescript').typescript,
        file: 'service.ts',
        code: `@Injectable()
export class AuthService {
    constructor(private readonly db: any) {}
    async findAll(): Promise<any[]> {
        return this.db.query('SELECT * FROM users');
    }
    async findById(id: string): Promise<any> {
        return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
    }
    async create(data: any): Promise<any> {
        return this.db.insert('users', data);
    }
}
export interface User { id: string; name: string; }`,
    },
    {
        lang: 'javascript',
        grammar: () => require('tree-sitter-javascript'),
        file: 'routes.js',
        code: `function handleGet(req, res) {
    const users = req.db.query('SELECT * FROM users');
    res.json({ data: users });
}
function handlePost(req, res) {
    const user = req.db.insert('users', req.body);
    res.status(201).json(user);
}
function handleDelete(req, res) {
    req.db.delete('users', req.params.id);
    res.sendStatus(204);
}`,
    },
    {
        lang: 'python',
        grammar: () => require('tree-sitter-python'),
        file: 'views.py',
        code: `class ProductView:
    def get(self, request):
        return JsonResponse({'status': 'ok'})
    def post(self, request):
        return JsonResponse({'status': 'created'})
    def delete(self, request):
        return JsonResponse({'status': 'deleted'})
def search(query):
    return []
def categories():
    return []`,
    },
    {
        lang: 'go',
        grammar: () => require('tree-sitter-go'),
        file: 'handler.go',
        code: `package api
func NewHandler() *Handler { return &Handler{} }
func (h *Handler) GetUsers(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}
func (h *Handler) CreateUser(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(201)
}
func (h *Handler) DeleteUser(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(204)
}`,
    },
    {
        lang: 'rust',
        grammar: () => require('tree-sitter-rust'),
        file: 'lib.rs',
        code: `pub struct Cache {
    data: HashMap<String, String>,
}
impl Cache {
    pub fn new() -> Self {
        Cache { data: HashMap::new() }
    }
    pub fn get(&self, key: &str) -> Option<&String> {
        self.data.get(key)
    }
    pub fn set(&mut self, key: String, val: String) {
        self.data.insert(key, val);
    }
}
pub fn default_cache() -> Cache { Cache::new() }`,
    },
    {
        lang: 'ruby',
        grammar: () => require('tree-sitter-ruby'),
        file: 'user.rb',
        code: `class User
  def initialize(name)
    @name = name
  end
  def authenticate(pass)
    pass == 'secret'
  end
  def to_s
    @name
  end
end
def validate(email)
  email.include?('@')
end`,
    },
    {
        lang: 'java',
        grammar: () => require('tree-sitter-java'),
        file: 'UserService.java',
        code: `public class UserService {
    public List<Object> findAll() {
        return List.of();
    }
    public Optional<Object> findById(long id) {
        return Optional.empty();
    }
    public Object create(Object dto) {
        return new Object();
    }
    public void delete(long id) {
        // delete
    }
}`,
    },
    {
        lang: 'c',
        grammar: () => require('tree-sitter-c'),
        file: 'hash.c',
        code: `#include <stdlib.h>
HashTable *hashtable_create(void) {
    HashTable *ht = malloc(sizeof(HashTable));
    ht->capacity = 16;
    ht->size = 0;
    return ht;
}
void *hashtable_get(HashTable *ht, const char *key) {
    unsigned long idx = hash_key(key) % ht->capacity;
    return ht->buckets[idx];
}
void hashtable_set(HashTable *ht, const char *key, void *value) {
    ht->buckets[0] = value;
    ht->size++;
}`,
    },
    {
        lang: 'php',
        grammar: () => require('tree-sitter-php').php,
        file: 'Controller.php',
        code: `<?php
class UserController {
    public function index() {
        return response()->json([]);
    }
    public function store() {
        return response()->json(['status' => 'created'], 201);
    }
    public function show($id) {
        return response()->json(['id' => $id]);
    }
}`,
    },
];

async function main() {
    console.log(c.bold('\n━━━ BrainBank Tree-Sitter Benchmark ━━━\n'));

    const parser = new Parser();
    const results = [];

    for (const test of TESTS) {
        try {
            const grammar = test.grammar();
            parser.setLanguage(grammar);

            const tree = parser.parse(test.code);
            const root = tree.rootNode;
            const lines = test.code.split('\n').length;

            // Extract top-level nodes
            const nodes = [];
            for (let i = 0; i < root.childCount; i++) {
                const child = root.child(i);
                nodes.push({
                    type: child.type,
                    text: child.text?.slice(0, 40)?.replace(/\n/g, ' '),
                    lines: `L${child.startPosition.row+1}-${child.endPosition.row+1}`,
                });
            }

            // Benchmark
            const times = [];
            for (let i = 0; i < 5; i++) {
                const start = performance.now();
                parser.parse(test.code);
                times.push(performance.now() - start);
            }
            const avg = times.reduce((a, b) => a + b) / times.length;

            const nodeTypes = [...new Set(nodes.map(n => n.type))].join(', ');
            results.push({ lang: test.lang, file: test.file, lines, nodes: nodes.length, avg, ok: true, nodeTypes });

            console.log(`${c.green('✓')} ${c.cyan(test.lang.padEnd(12))} ${test.file.padEnd(18)} ${String(lines).padStart(3)} lines  ${String(nodes.length).padStart(2)} nodes  ${avg.toFixed(2).padStart(6)}ms`);
            for (const n of nodes.slice(0, 5)) {
                console.log(`  ${c.dim('└')} ${n.type} ${n.lines}: ${c.dim(n.text || '')}`);
            }
        } catch (err) {
            results.push({ lang: test.lang, file: test.file, lines: 0, nodes: 0, avg: -1, ok: false, nodeTypes: 'ERROR' });
            console.log(`${c.red('✗')} ${c.cyan(test.lang.padEnd(12))} ${test.file.padEnd(18)} ${err.message?.split('\n')[0]}`);
        }
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${c.bold('━━━ Summary ━━━')}`);
    console.log(`  ${c.green(`${passed} parsed`)}  ${failed > 0 ? c.red(`${failed} failed`) : ''}`);
    console.log();
}

main().catch(console.error);

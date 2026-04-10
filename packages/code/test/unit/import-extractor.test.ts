/**
 * Unit Tests — Import Extractor
 *
 * Tests regex-based import extraction across all supported languages.
 */

import { extractImports } from '../../src/graph/import-extractor.ts';

export const name = 'Import Extractor';

export const tests = {
    'extracts TypeScript/ESM imports'(assert: any) {
        const code = `
import { Foo } from './foo';
import Bar from '../bar';
import type { Baz } from '@/types';
import { readFile } from 'node:fs';
`;
        const imports = extractImports(code, 'typescript');
        assert.includes(imports, 'foo');
        assert.includes(imports, 'bar');
        assert.includes(imports, '@/types');
        assert.includes(imports, 'node:fs');
    },

    'extracts JavaScript require()'(assert: any) {
        const code = `
const fs = require('fs');
const path = require('path');
const { parse } = require('./utils/parser');
`;
        const imports = extractImports(code, 'javascript');
        assert.includes(imports, 'fs');
        assert.includes(imports, 'path');
        assert.includes(imports, 'parser');
    },

    'extracts Python imports'(assert: any) {
        const code = `
import os
import sys
from typing import Optional, List
from pinecall.session.turn_manager import TurnManager
from .utils import helper
`;
        const imports = extractImports(code, 'python');
        assert.includes(imports, 'os');
        assert.includes(imports, 'sys');
        assert.includes(imports, 'typing');
        assert.ok(imports.some(i => i.includes('pinecall')), 'should have pinecall import');
    },

    'extracts Go imports'(assert: any) {
        const code = `
import "fmt"
import (
    "net/http"
    "encoding/json"
    "github.com/gorilla/mux"
)
`;
        const imports = extractImports(code, 'go');
        assert.includes(imports, 'fmt');
        assert.includes(imports, 'net/http');
        assert.includes(imports, 'encoding/json');
    },

    'extracts Ruby requires'(assert: any) {
        const code = `
require 'json'
require_relative 'config'
require 'httparty'
`;
        const imports = extractImports(code, 'ruby');
        assert.includes(imports, 'json');
        assert.includes(imports, 'config');
        assert.includes(imports, 'httparty');
    },

    'extracts Rust use statements'(assert: any) {
        const code = `
use std::io::Read;
use serde::Deserialize;
mod config;
`;
        const imports = extractImports(code, 'rust');
        assert.includes(imports, 'io::Read');
        assert.includes(imports, 'serde::Deserialize');
        assert.includes(imports, 'config');
    },

    'extracts C/C++ includes'(assert: any) {
        const code = `
#include <stdio.h>
#include "myheader.h"
#include <vector>
`;
        const imports = extractImports(code, 'c');
        assert.includes(imports, 'stdio');
        assert.includes(imports, 'myheader');
        assert.includes(imports, 'vector');
    },

    'extracts Java imports'(assert: any) {
        const code = `
import java.util.List;
import static org.junit.Assert.*;
import com.example.service.UserService;
`;
        const imports = extractImports(code, 'java');
        // simplifyModule truncates to last 2 segments for dotted paths
        assert.ok(imports.some((i: string) => i.includes('util')), 'should have java.util import');
        assert.ok(imports.some((i: string) => i.includes('Assert')), 'should have Assert import');
        assert.ok(imports.some((i: string) => i.includes('service')), 'should have service import');
    },

    'extracts CSS @import'(assert: any) {
        const code = `
@import url('reset.css');
@import 'variables.css';
`;
        const imports = extractImports(code, 'css');
        assert.includes(imports, 'reset');
        assert.includes(imports, 'variables');
    },

    'returns empty for unsupported language'(assert: any) {
        const imports = extractImports('some code', 'brainfuck');
        assert.equal(imports.length, 0);
    },

    'deduplicates imports'(assert: any) {
        const code = `
import { A } from './shared';
import { B } from './shared';
`;
        const imports = extractImports(code, 'typescript');
        const sharedCount = imports.filter(i => i === 'shared').length;
        assert.equal(sharedCount, 1, 'should deduplicate same module');
    },

    'handles empty content'(assert: any) {
        const imports = extractImports('', 'typescript');
        assert.equal(imports.length, 0);
    },
};

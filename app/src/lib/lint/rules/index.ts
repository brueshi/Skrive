// The rule registry. Order is significant — findings are sorted by
// (path, line, column) at the engine level, but ties break by registry
// order so output is fully deterministic.

import { brokenInternalLinksRule } from './broken-internal-links';
import { duplicateHeadingsRule } from './duplicate-headings';
import { headingHierarchyRule } from './heading-hierarchy';
import { missingRequiredFrontmatterRule } from './missing-required-frontmatter';
import { orphanedFilesRule } from './orphaned-files';
import type { Rule } from '../types';

export const RULES: Rule[] = [
  brokenInternalLinksRule,
  missingRequiredFrontmatterRule,
  headingHierarchyRule,
  orphanedFilesRule,
  duplicateHeadingsRule
];

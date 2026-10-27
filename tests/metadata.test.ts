import { describe, expect, it } from 'vitest';
import packageMetadata from '../package.json';
import license from '../LICENSE?raw';
import mit from '../LICENSE-MIT?raw';
import apache from '../LICENSE-APACHE?raw';
import englishReadme from '../README.md?raw';
import chineseReadme from '../README.zh-CN.md?raw';
import thirdPartyNotices from '../public/assets/third-party-notices.txt?raw';

describe('distribution licensing', () => {
    it('consistently offers MIT OR Apache-2.0 and includes both license texts', () => {
        expect(packageMetadata.license).toBe('(MIT OR Apache-2.0)');
        expect(license).toContain('SPDX-License-Identifier: MIT OR Apache-2.0');
        expect(license).toContain('2026 Loginflare contributors');
        expect(mit).toContain('Permission is hereby granted, free of charge');
        expect(mit).toContain('2026 Loginflare contributors');
        expect(apache).toContain('Version 2.0, January 2004');
        expect(thirdPartyNotices).toContain('react@');
        expect(thirdPartyNotices).toContain('better-auth@');
        expect(thirdPartyNotices).toContain('@material/web@2.5.0');
        expect(thirdPartyNotices).toContain('@lit-labs/ssr-dom-shim@1.6.0');
        expect(thirdPartyNotices).toContain('Copyright 2019 Google LLC');
        expect(thirdPartyNotices).toContain('BSD 3-Clause License');
        expect(thirdPartyNotices).toContain('20afabd3c5bfd49fdcdf1b8518e05c7f99a46db6');
        expect(thirdPartyNotices).toContain('Permission is hereby granted');
        for (const readme of [englishReadme, chineseReadme]) {
            expect(readme).toContain('MIT OR Apache-2.0');
            expect(readme).toContain('LICENSE-MIT');
            expect(readme).toContain('LICENSE-APACHE');
        }
    });
});

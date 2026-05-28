import { describe, expect, it } from "vitest";
import {
	checkSwiftAtsArbitraryLoads,
	checkSwiftHttpUrlLiteral,
	checkSwiftUserDefaultsForSecret,
	checkSwiftWeakCrypto,
} from "./swift-security.js";

describe("checkSwiftWeakCrypto", () => {
	it("flags CC_MD5", () => {
		const code = "CC_MD5(input, CC_LONG(len), &out)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift").length).toBe(1);
	});

	it("flags CC_SHA1", () => {
		const code = "CC_SHA1(input, CC_LONG(len), &out)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift").length).toBe(1);
	});

	it("flags CryptoKit Insecure.MD5", () => {
		const code = "let h = Insecure.MD5.hash(data: data)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift").length).toBe(1);
	});

	it("flags Insecure.SHA1", () => {
		const code = "let h = Insecure.SHA1.hash(data: data)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift").length).toBe(1);
	});

	it("flags kCCAlgorithmDES", () => {
		const code = "CCCryptorCreate(op, kCCAlgorithmDES, opts, key, len, iv, &cryptor)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift").length).toBe(1);
	});

	it("does not flag SHA256 (modern hash)", () => {
		const code = "let h = SHA256.hash(data: data)";
		expect(checkSwiftWeakCrypto(code, "Crypto.swift")).toEqual([]);
	});

	it("does not flag inside a string literal", () => {
		const code = 'let s = "do not use CC_MD5 here"';
		expect(checkSwiftWeakCrypto(code, "Crypto.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = "CC_MD5(input)";
		expect(checkSwiftWeakCrypto(code, "Crypto.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = "CC_MD5(input)";
		expect(checkSwiftWeakCrypto(code, "CryptoTests.swift")).toEqual([]);
	});
});

describe("checkSwiftHttpUrlLiteral", () => {
	it("flags URL(string: \"http://...\")", () => {
		const code = 'let u = URL(string: "http://api.example.com/v1")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift").length).toBe(1);
	});

	it("flags any string literal with http:// prefix", () => {
		const code = 'let endpoint = "http://api.example.com/users"';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift").length).toBe(1);
	});

	it("does not flag https://", () => {
		const code = 'let u = URL(string: "https://api.example.com/v1")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	it("does not flag http://localhost (ATS allows it)", () => {
		const code = 'let u = URL(string: "http://localhost:8080/test")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	it("does not flag http://127.0.0.1", () => {
		const code = 'let u = URL(string: "http://127.0.0.1:9000/")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	it("does not flag http://device.local (ATS-permitted)", () => {
		const code = 'let u = URL(string: "http://my-printer.local/status")';
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	it("does not flag in a comment", () => {
		const code = "// example: http://api.example.com/foo";
		expect(checkSwiftHttpUrlLiteral(code, "Net.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = '"http://api.example.com/v1"';
		expect(checkSwiftHttpUrlLiteral(code, "Net.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = 'let u = URL(string: "http://api.example.com/v1")';
		expect(checkSwiftHttpUrlLiteral(code, "NetTests.swift")).toEqual([]);
	});
});

describe("checkSwiftUserDefaultsForSecret", () => {
	it("flags UserDefaults.standard.set with forKey: password", () => {
		const code = 'UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	it("flags UserDefaults.standard.set with forKey: apiKey", () => {
		const code = 'UserDefaults.standard.set(key, forKey: "apiKey")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	it("flags UserDefaults.standard.set with forKey: access_token", () => {
		const code = 'UserDefaults.standard.set(t, forKey: "access_token")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift").length).toBe(1);
	});

	it("flags @AppStorage with secret key", () => {
		const code = '@AppStorage("authToken") var authToken: String = ""';
		expect(checkSwiftUserDefaultsForSecret(code, "View.swift").length).toBe(1);
	});

	it("does not flag UserDefaults for non-sensitive key", () => {
		const code = 'UserDefaults.standard.set(true, forKey: "hasSeenOnboarding")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.swift")).toEqual([]);
	});

	it("does not flag @AppStorage for theme preference", () => {
		const code = '@AppStorage("themePreference") var theme: String = "dark"';
		expect(checkSwiftUserDefaultsForSecret(code, "View.swift")).toEqual([]);
	});

	it("does not flag in non-Swift files", () => {
		const code = 'UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "Auth.ts")).toEqual([]);
	});

	it("skips test files", () => {
		const code = 'UserDefaults.standard.set(pw, forKey: "password")';
		expect(checkSwiftUserDefaultsForSecret(code, "AuthTests.swift")).toEqual([]);
	});
});

describe("checkSwiftAtsArbitraryLoads", () => {
	it("flags NSAllowsArbitraryLoads true in Info.plist", () => {
		const code = `<plist><dict>
			<key>NSAppTransportSecurity</key>
			<dict>
				<key>NSAllowsArbitraryLoads</key>
				<true/>
			</dict>
		</dict></plist>`;
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	it("flags NSExceptionAllowsInsecureHTTPLoads true", () => {
		const code = `<plist><dict>
			<key>NSExceptionAllowsInsecureHTTPLoads</key>
			<true/>
		</dict></plist>`;
		expect(checkSwiftAtsArbitraryLoads(code, "App.plist").length).toBe(1);
	});

	it("flags YES-string form", () => {
		const code = `<plist><dict>
			<key>NSAllowsArbitraryLoads</key>
			<string>YES</string>
		</dict></plist>`;
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	it("does not flag NSAllowsArbitraryLoads false", () => {
		const code = `<plist><dict>
			<key>NSAllowsArbitraryLoads</key>
			<false/>
		</dict></plist>`;
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	it("still flags NSExceptionAllowsInsecureHTTPLoads under NSExceptionDomains (scoped form)", () => {
		const code = `<plist><dict>
			<key>NSAppTransportSecurity</key>
			<dict>
				<key>NSExceptionDomains</key>
				<dict>
					<key>legacy-api.example.com</key>
					<dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/></dict>
				</dict>
			</dict>
		</dict></plist>`;
		// The scoped form (a single legacy host) is narrower than a blanket
		// `NSAllowsArbitraryLoads = true`, but it still grants cleartext for
		// that host. Worth surfacing so the dev confirms it's intentional.
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist").length).toBe(1);
	});

	it("does not flag a plist without ATS keys", () => {
		const code = `<plist><dict>
			<key>CFBundleName</key><string>App</string>
		</dict></plist>`;
		expect(checkSwiftAtsArbitraryLoads(code, "Info.plist")).toEqual([]);
	});

	it("does not run on .swift files", () => {
		const code = "NSAllowsArbitraryLoads";
		expect(checkSwiftAtsArbitraryLoads(code, "Foo.swift")).toEqual([]);
	});
});

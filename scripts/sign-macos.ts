import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

export default async function sign(options: SignOptions): Promise<void> {
  await signApplication({
    ...options,
    ...(options.identity === "-"
      ? {
          identityValidation: false,
          preAutoEntitlements: false,
          preEmbedProvisioningProfile: false,
          optionsForFile: () => ({
            hardenedRuntime: true,
            timestamp: "none",
            entitlements: [
              "com.apple.security.cs.allow-jit",
              "com.apple.security.cs.allow-unsigned-executable-memory",
              // Ad-hoc code has no Team ID for the runtime's library validation.
              "com.apple.security.cs.disable-library-validation",
              "com.apple.security.device.camera",
              "com.apple.security.device.audio-input",
            ],
          }),
        }
      : {}),
    batchCodesignCalls: true,
  });
}

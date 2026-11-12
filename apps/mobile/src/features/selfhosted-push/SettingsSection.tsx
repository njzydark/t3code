import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";
import { Linking, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Dialog from "../../components/ui/Dialog";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { SettingsRow } from "../settings/components/SettingsRow";
import {
  hasSelfHostedPushTargetsAtom,
  refreshSelfHostedPush,
  selfHostedPushStatusAtom,
} from "./runtime";

type PushPreferencesPatch = {
  selfHostedPushEnabled?: boolean;
  selfHostedLiveActivitiesEnabled?: boolean;
};

async function updatePushPreferences(patch: PushPreferencesPatch, save: () => Promise<boolean>) {
  if (patch.selfHostedPushEnabled) {
    const permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted && !permission.canAskAgain) await Linking.openSettings();
  }
  if (!(await save())) throw new Error("Preference update failed");
  await refreshSelfHostedPush();
}

export function SelfHostedPushSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const status = useAtomValue(selfHostedPushStatusAtom);
  const hasTargets = useAtomValue(hasSelfHostedPushTargetsAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promiseExit" });
  const [saving, setSaving] = useState(false);
  if (Platform.OS !== "ios" || !hasTargets) return null;
  const value = AsyncResult.isSuccess(preferences) ? preferences.value : null;
  const update = async (patch: PushPreferencesPatch) => {
    if (saving) return;
    setSaving(true);
    await updatePushPreferences(patch, async () =>
      Exit.isSuccess(await savePreferences(patch)),
    ).catch(() => {
      Dialog.alert(
        "Self-hosted notifications unavailable",
        "Check notification permissions, the Relay's APNs configuration, and this app's signing identity.",
      );
    });
    setSaving(false);
  };
  return (
    <SettingsSection title="Self-hosted Relay">
      <SettingsRow icon="bell.badge" label="Push service" value={status} valuePosition="below" />
      <SettingsRow
        icon="bell.badge"
        label="Allow notifications on this device"
        disabled={!value || saving}
        onPress={() => {
          void update({ selfHostedPushEnabled: true });
        }}
      />
      <SettingsSwitchRow
        icon="bell.badge"
        label="Use self-hosted push"
        subtitle="Requires push to be enabled on your Relay with credentials matching this app. Independent of T3 Connect."
        disabled={!value || saving}
        value={value?.selfHostedPushEnabled !== false}
        onValueChange={(enabled) => {
          void update({ selfHostedPushEnabled: enabled });
        }}
      />
      <SettingsSwitchRow
        icon="bell.badge"
        label="Self-hosted Live Activities"
        disabled={!value || saving || value.selfHostedPushEnabled === false}
        value={value?.selfHostedLiveActivitiesEnabled !== false}
        onValueChange={(enabled) => {
          void update({ selfHostedLiveActivitiesEnabled: enabled });
        }}
      />
    </SettingsSection>
  );
}

import * as k8s from '@kubernetes/client-node';
import { getKubeconfigPrefs } from '@dokkimi/config';

export function loadKubeConfig(): k8s.KubeConfig {
  const prefs = getKubeconfigPrefs();
  const kc = new k8s.KubeConfig();
  kc.loadFromDefault();

  if (prefs.context) {
    kc.setCurrentContext(prefs.context);
  }

  return kc;
}

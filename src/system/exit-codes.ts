// Codes de sortie de la CLI (sysexits.h). 78 est attendu par les unités systemd
// (RestartPreventExitStatus=78) et par les tests de livraison : « exécuter lockmaster init ».

export const EXIT = {
  OK: 0,
  FAILURE: 1,
  USAGE: 64,
  SOFTWARE: 70,
  NO_PERMISSION: 77,
  CONFIG: 78,
} as const;

import { raiseDeploymentTarget } from '../index';

/** The shape `withXcodeProject` hands the plugin, reduced to what it reads. */
function project(targets: Record<string, string | undefined>) {
  const section: Record<string, { buildSettings?: Record<string, unknown> }> = {};
  for (const [name, target] of Object.entries(targets)) {
    section[name] = { buildSettings: target === undefined ? {} : { IPHONEOS_DEPLOYMENT_TARGET: target } };
  }
  return { section, pbxXCBuildConfigurationSection: () => section };
}

describe('raiseDeploymentTarget', () => {
  it("raises a configuration below the desert-ant-core package floor", () => {
    const p = project({ Debug: '16.4', Release: '16.4' });
    raiseDeploymentTarget(p);
    expect(p.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
    expect(p.section.Release!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
  });

  it('never lowers one that is already higher', () => {
    // The case that matters in practice: an app that also installs Clips has
    // been raised to 18.0 by its plugin, and this one must not undo that
    // whichever order the two run in.
    const p = project({ Release: '18.0' });
    raiseDeploymentTarget(p);
    expect(p.section.Release!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('18.0');
  });

  it('leaves a configuration that inherits the project value inheriting it', () => {
    const p = project({ Debug: undefined });
    raiseDeploymentTarget(p);
    expect(p.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBeUndefined();
  });

  it('is idempotent, as a re-run of prebuild would be', () => {
    const p = project({ Debug: '16.4' });
    raiseDeploymentTarget(p);
    raiseDeploymentTarget(p);
    expect(p.section.Debug!.buildSettings!.IPHONEOS_DEPLOYMENT_TARGET).toBe('17.0');
  });
});

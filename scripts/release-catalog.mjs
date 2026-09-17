// Independent release units. Trigger tags are disjoint from local release records.
export const catalog = {
  "project": "frely-cli",
  "defaultArtifact": "cli",
  "artifacts": [
    {
      "id": "cli",
      "defaultExecutor": "actions",
      "executors": [
        "actions"
      ],
      "tagPrefix": "v",
      "packagePath": "package.json",
      "workflow": "publish.yml",
      "description": "npm package, eight standalone targets, checksums and installers"
    },
    {
      "id": "landing",
      "defaultExecutor": "actions",
      "executors": [
        "actions"
      ],
      "tagPrefix": "landing/v",
      "workflow": "site.yml",
      "description": "cli.frely.cloud GitHub Pages site"
    }
  ]
};

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUpdateGitlabIntegration } from "@/hooks/mutations/gitlab-integration/use-update-gitlab-integration";
import { toast } from "@/lib/toast";

type GitlabAssigneeSectionProps = {
  projectId: string;
  ownsAssignees: boolean;
};

export function GitlabAssigneeSection({
  projectId,
  ownsAssignees,
}: GitlabAssigneeSectionProps) {
  const { t } = useTranslation();
  const id = useId();
  const { mutateAsync: update, isPending } = useUpdateGitlabIntegration();

  const changeOwnership = async (checked: boolean) => {
    try {
      await update({ projectId, json: { gitlabOwnsAssignees: checked } });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("settings:gitlabIntegration.toast.settingsUpdateError"),
      );
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor={id}>
          {t("settings:gitlabIntegration.assigneeSourceTitle")}
        </Label>
        <p id={`${id}-description`} className="text-xs text-muted-foreground">
          {t("settings:gitlabIntegration.assigneeSourceHint")}
        </p>
      </div>
      <Switch
        id={id}
        aria-describedby={`${id}-description`}
        checked={ownsAssignees}
        onCheckedChange={changeOwnership}
        disabled={isPending}
      />
    </div>
  );
}

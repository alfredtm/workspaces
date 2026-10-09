{{- define "workspaces.labels" -}}
app.kubernetes.io/name: workspaces
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "workspaces.portalHost" -}}
{{ printf "%s.%s" .Values.portalLabel .Values.domain }}
{{- end }}

{{- define "workspaces.image" -}}
{{- $root := index . 0 -}}{{- $override := index . 1 -}}{{- $suffix := index . 2 -}}
{{- if $override -}}{{ $override }}{{- else -}}{{ printf "%s%s:%s" $root.Values.image.registry $suffix $root.Values.image.tag }}{{- end -}}
{{- end }}

{{- define "workspaces.workspaceNamespace" -}}
{{ .Values.workspaceNamespace.name | default (printf "%s-users" .Release.Namespace) }}
{{- end }}

{{- define "workspaces.inferenceSecret" -}}
{{ .Values.inference.existingSecret | default "workspace-inference" }}
{{- end }}

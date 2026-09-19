{{- define "lf.secretName" -}}
{{- if .Values.existingSecret }}{{ .Values.existingSecret }}{{ else }}{{ .Release.Name }}-config{{ end -}}
{{- end -}}

{{- define "lf.labels" -}}
app.kubernetes.io/name: ledgerforge
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

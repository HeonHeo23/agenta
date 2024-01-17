import React, {useEffect, useMemo, useRef, useState} from "react"
import {AgGridReact} from "ag-grid-react"
import {useAppTheme} from "@/components/Layout/ThemeContextProvider"
import {ColDef} from "ag-grid-community"
import {createUseStyles} from "react-jss"
import {Button, Empty, Space, Spin, Tag, Tooltip, Typography, theme} from "antd"
import {DeleteOutlined, PlusCircleOutlined, SlidersOutlined, SwapOutlined} from "@ant-design/icons"
import {EvaluationStatus, GenericObject, JSSTheme, TypedValue, _Evaluation} from "@/lib/Types"
import {capitalize, round, uniqBy} from "lodash"
import dayjs from "dayjs"
import relativeTime from "dayjs/plugin/relativeTime"
import duration from "dayjs/plugin/duration"
import NewEvaluationModal from "./NewEvaluationModal"
import {useAppId} from "@/hooks/useAppId"
import {deleteEvaluations, fetchAllEvaluations, fetchEvaluationStatus} from "@/services/evaluations"
import {useUpdateEffect} from "usehooks-ts"
import {shortPoll} from "@/lib/helpers/utils"
import AlertPopup from "@/components/AlertPopup/AlertPopup"
import {
    LinkCellRenderer,
    StatusRenderer,
    runningStatuses,
    statusMapper,
} from "../cellRenderers/cellRenderers"
import {useAtom} from "jotai"
import {evaluatorsAtom} from "@/lib/atoms/evaluation"
import AgCustomHeader from "@/components/AgCustomHeader/AgCustomHeader"
import {useRouter} from "next/router"
dayjs.extend(relativeTime)
dayjs.extend(duration)

const useStyles = createUseStyles((theme: JSSTheme) => ({
    emptyRoot: {
        height: "calc(100vh - 260px)",
        display: "grid",
        placeItems: "center",
    },
    root: {
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
    },
    table: {
        height: "calc(100vh - 260px)",
    },
    buttonsGroup: {
        marginTop: "1rem",
        alignSelf: "flex-end",
    },
}))

export function getTypedValue(res?: TypedValue) {
    const {value, type} = res || {}
    return type === "number"
        ? round(Number(value), 2)
        : ["boolean", "bool"].includes(type as string)
          ? capitalize(value?.toString())
          : value?.toString()
}

export function getFilterParams(type: "number" | "text" | "date") {
    const filterParams: GenericObject = {}
    if (type == "date") {
        filterParams.comparator = function (
            filterLocalDateAtMidnight: Date,
            cellValue: string | null,
        ) {
            if (cellValue == null) return -1
            const cellDate = dayjs(cellValue).startOf("day").toDate()
            if (filterLocalDateAtMidnight.getTime() === cellDate.getTime()) {
                return 0
            }
            if (cellDate < filterLocalDateAtMidnight) {
                return -1
            }
            if (cellDate > filterLocalDateAtMidnight) {
                return 1
            }
        }
    }

    return {
        sortable: true,
        floatingFilter: true,
        filter:
            type === "number"
                ? "agNumberColumnFilter"
                : type === "date"
                  ? "agDateColumnFilter"
                  : "agTextColumnFilter",
        cellDataType: type,
        filterParams,
    }
}

export const calcEvalDuration = (evaluation: _Evaluation) => {
    return dayjs(
        runningStatuses.includes(evaluation.status) ? Date.now() : evaluation.updated_at,
    ).diff(dayjs(evaluation.created_at), "milliseconds")
}

interface Props {}

const EvaluationResults: React.FC<Props> = () => {
    const {appTheme} = useAppTheme()
    const classes = useStyles()
    const appId = useAppId()
    const [evaluations, setEvaluations] = useState<_Evaluation[]>([])
    const [evaluators] = useAtom(evaluatorsAtom)
    const [newEvalModalOpen, setNewEvalModalOpen] = useState(false)
    const [fetching, setFetching] = useState(false)
    const [selected, setSelected] = useState<_Evaluation[]>([])
    const stoppers = useRef<Function>()
    const router = useRouter()
    const {token} = theme.useToken()
    const gridRef = useRef<AgGridReact>()

    const runningEvaluationIds = useMemo(
        () =>
            evaluations
                .filter((item) => runningStatuses.includes(item.status))
                .map((item) => item.id),
        [evaluations],
    )

    const onDelete = () => {
        AlertPopup({
            title: "Delete Evaluations",
            message: `Are you sure you want to delete all ${selected.length} selected evaluations?`,
            onOk: () =>
                deleteEvaluations(selected.map((item) => item.id))
                    .catch(console.error)
                    .then(fetcher),
        })
    }

    const fetcher = () => {
        setFetching(true)
        fetchAllEvaluations(appId)
            .then(setEvaluations)
            .catch(console.error)
            .finally(() => setFetching(false))
    }

    useEffect(() => {
        fetcher()
    }, [appId])

    //update status of running evaluations through short polling
    useUpdateEffect(() => {
        stoppers.current?.()

        if (runningEvaluationIds.length) {
            stoppers.current = shortPoll(
                () =>
                    Promise.all(runningEvaluationIds.map((id) => fetchEvaluationStatus(id)))
                        .then((res) => {
                            setEvaluations((prev) => {
                                const newEvals = [...prev]
                                runningEvaluationIds.forEach((id, ix) => {
                                    const index = newEvals.findIndex((e) => e.id === id)
                                    if (index !== -1) {
                                        newEvals[index].status = res[ix].status
                                        newEvals[index].duration = calcEvalDuration(newEvals[index])
                                    }
                                })
                                if (res.some((item) => !runningStatuses.includes(item.status)))
                                    fetcher()
                                return newEvals
                            })
                        })
                        .catch(console.error),
                {delayMs: 2000, timeoutMs: Infinity},
            ).stopper
        }

        return () => {
            stoppers.current?.()
        }
    }, [JSON.stringify(runningEvaluationIds)])

    const evaluatorConfigs = useMemo(
        () =>
            uniqBy(
                evaluations
                    .map((item) =>
                        item.aggregated_results.map((item) => ({
                            ...item.evaluator_config,
                            evaluator: evaluators.find(
                                (e) => e.key === item.evaluator_config.evaluator_key,
                            ),
                        })),
                    )
                    .flat(),
                "id",
            ),
        [evaluations],
    )

    const colDefs = useMemo(() => {
        const colDefs: ColDef<_Evaluation>[] = [
            {
                field: "variants",
                flex: 1,
                minWidth: 160,
                pinned: "left",
                headerCheckboxSelection: true,
                checkboxSelection: true,
                showDisabledCheckboxes: true,
                cellRenderer: (params: any) => (
                    <LinkCellRenderer
                        {...params}
                        href={`/apps/${appId}/playground/?variant=${params.value}`}
                    />
                ),
                valueGetter: (params) => params.data?.variants[0].variantName,
                headerName: "Variant",
                tooltipValueGetter: (params) => params.data?.variants[0].variantName,
                ...getFilterParams("text"),
            },
            {
                field: "testset.name",
                cellRenderer: (params: any) => (
                    <LinkCellRenderer
                        {...params}
                        href={`/apps/${appId}/testsets/${params.data?.testset.id}`}
                    />
                ),
                flex: 1,
                minWidth: 160,
                tooltipValueGetter: (params) => params.value,
                ...getFilterParams("text"),
            },
            ...evaluatorConfigs.map(
                (config) =>
                    ({
                        flex: 1,
                        minWidth: 190,
                        field: "aggregated_results",
                        headerComponent: (props: any) => (
                            <AgCustomHeader {...props}>
                                <Space
                                    direction="vertical"
                                    size="small"
                                    style={{padding: "0.75rem 0"}}
                                >
                                    <Space size="small">
                                        <SlidersOutlined />
                                        <span>{config.name}</span>
                                    </Space>
                                    <Tag color={config.evaluator?.color}>
                                        {config.evaluator?.name}
                                    </Tag>
                                </Space>
                            </AgCustomHeader>
                        ),
                        autoHeaderHeight: true,
                        ...getFilterParams("number"),
                        valueGetter: (params) =>
                            getTypedValue(
                                params.data?.aggregated_results.find(
                                    (item) => item.evaluator_config.id === config.id,
                                )?.result,
                            ),
                        tooltipValueGetter: (params) =>
                            params.data?.aggregated_results
                                .find((item) => item.evaluator_config.id === config.id)
                                ?.result?.value?.toString() || "",
                    }) as ColDef<_Evaluation>,
            ),
            {
                flex: 1,
                field: "status",
                minWidth: 185,
                ...getFilterParams("text"),
                filterValueGetter: (params) =>
                    statusMapper(token)[params.data?.status as EvaluationStatus].label,
                cellRenderer: StatusRenderer,
            },
            {
                flex: 1,
                field: "created_at",
                headerName: "Created",
                minWidth: 160,
                ...getFilterParams("date"),
                valueFormatter: (params) => dayjs(params.value).fromNow(),
            },
        ]
        return colDefs
    }, [evaluatorConfigs])

    const compareDisabled = useMemo(
        () =>
            selected.length < 2 ||
            selected.some(
                (item) =>
                    item.status !== EvaluationStatus.FINISHED ||
                    item.testset.id !== selected[0].testset.id,
            ),
        [selected],
    )

    const compareBtnNode = (
        <Button
            disabled={compareDisabled}
            icon={<SwapOutlined />}
            type="primary"
            data-cy="evaluation-results-compare-button"
            onClick={() =>
                router.push(
                    `/apps/${appId}/evaluations/compare/?evaluations=${selected
                        .map((item) => item.id)
                        .join(",")}`,
                )
            }
        >
            Compare
        </Button>
    )

    return (
        <>
            {!fetching && !evaluations.length ? (
                <div className={classes.emptyRoot}>
                    <Empty description="It looks like you haven't created an evaluation yet">
                        <Space direction="vertical">
                            <Button
                                icon={<PlusCircleOutlined />}
                                type="primary"
                                onClick={() => {
                                    setNewEvalModalOpen(true)
                                }}
                            >
                                Create Evaluation
                            </Button>
                            <Typography.Text>Or</Typography.Text>
                            <Button
                                icon={<SlidersOutlined />}
                                type="default"
                                onClick={() =>
                                    router.push(`/apps/${appId}/evaluations?tab=evaluators`)
                                }
                            >
                                Configure Evaluators
                            </Button>
                        </Space>
                    </Empty>
                </div>
            ) : (
                <div className={classes.root}>
                    <Space className={classes.buttonsGroup}>
                        <Button
                            disabled={selected.length === 0}
                            icon={<DeleteOutlined />}
                            type="primary"
                            danger
                            onClick={onDelete}
                        >
                            Delete
                        </Button>
                        {compareDisabled ? (
                            <Tooltip title="Select 2 or more evaluations from the same testset to compare">
                                {compareBtnNode}
                            </Tooltip>
                        ) : (
                            compareBtnNode
                        )}
                        <Button
                            icon={<PlusCircleOutlined />}
                            type="primary"
                            onClick={() => {
                                setNewEvalModalOpen(true)
                            }}
                            data-cy="new-evaluation-button"
                        >
                            New Evaluation
                        </Button>
                    </Space>
                    <Spin spinning={fetching}>
                        <div
                            className={`${
                                appTheme === "dark" ? "ag-theme-alpine-dark" : "ag-theme-alpine"
                            } ${classes.table}`}
                        >
                            <AgGridReact<_Evaluation>
                                ref={gridRef as any}
                                rowData={evaluations}
                                columnDefs={colDefs}
                                getRowId={(params) => params.data.id}
                                onRowClicked={(params) => {
                                    // ignore clicks on the checkbox col
                                    if (
                                        params.eventPath?.find(
                                            (item: any) => item.ariaColIndex === "1",
                                        )
                                    )
                                        return
                                    EvaluationStatus.FINISHED === params.data?.status &&
                                        router.push(`/apps/${appId}/evaluations/${params.data?.id}`)
                                }}
                                rowSelection="multiple"
                                suppressRowClickSelection
                                onSelectionChanged={(event) =>
                                    setSelected(event.api.getSelectedRows())
                                }
                                tooltipShowDelay={0}
                            />
                        </div>
                    </Spin>
                </div>
            )}
            <NewEvaluationModal
                open={newEvalModalOpen}
                onCancel={() => setNewEvalModalOpen(false)}
                onSuccess={() => {
                    setNewEvalModalOpen(false)
                    fetcher()
                }}
            />
        </>
    )
}

export default EvaluationResults

import React from 'react';
import { useShow, useResource } from '@refinedev/core';
import {
  List,
  Show,
  Create,
  Edit,
  useTable,
  EditButton,
  ShowButton,
  DeleteButton,
  useForm,
} from '@refinedev/antd';
import {
  Table,
  Space,
  Form,
  Input,
  InputNumber,
  Switch,
  DatePicker,
  Select,
  Typography,
} from 'antd';
import dayjs from 'dayjs';

const { Text } = Typography;

const renderCell = (field, value) => {
  if (value == null) return <Text type="secondary">—</Text>;
  switch (field.type) {
    case 'date':
      return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '';
    case 'boolean':
      return value ? 'true' : 'false';
    case 'array':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'object':
      return <Text code>{JSON.stringify(value)}</Text>;
    case 'file':
      return value && value.url ? (
        <a href={value.url} target="_blank" rel="noreferrer">
          {value.originalName || 'file'}
        </a>
      ) : (
        <Text type="secondary">—</Text>
      );
    default:
      return String(value);
  }
};

const fieldInput = (field) => {
  if (field.type === 'enum' && Array.isArray(field.enum)) {
    return (
      <Select
        allowClear
        options={field.enum.map((v) => ({ label: String(v), value: v }))}
      />
    );
  }
  switch (field.type) {
    case 'number':
      return <InputNumber style={{ width: '100%' }} />;
    case 'boolean':
      return <Switch />;
    case 'date':
      return <DatePicker showTime style={{ width: '100%' }} />;
    case 'array':
      return <Select mode="tags" tokenSeparators={[',']} />;
    case 'file':
      return (
        <Text type="secondary">
          File fields are uploaded via the dedicated multipart route — the
          admin form does not edit them inline.
        </Text>
      );
    default:
      return <Input />;
  }
};

export function ResourceList({ resourceName, fields }) {
  const { tableProps } = useTable({ resource: resourceName, syncWithLocation: true });
  return (
    <List>
      <Table
        {...tableProps}
        rowKey="_id"
        scroll={{ x: 'max-content' }}
        columns={[
          ...fields
            .filter((f) => f.type !== 'file' && f.type !== 'object')
            .slice(0, 6)
            .map((f) => ({
              title: f.name,
              dataIndex: f.name,
              render: (value) => renderCell(f, value),
            })),
          {
            title: 'createdAt',
            dataIndex: 'createdAt',
            render: (v) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : ''),
          },
          {
            title: 'actions',
            key: 'actions',
            render: (_, record) => (
              <Space>
                <EditButton hideText size="small" recordItemId={record._id} />
                <ShowButton hideText size="small" recordItemId={record._id} />
                <DeleteButton hideText size="small" recordItemId={record._id} />
              </Space>
            ),
          },
        ]}
      />
    </List>
  );
}

export function ResourceShow({ resourceName, fields }) {
  const { queryResult } = useShow({ resource: resourceName });
  const record = queryResult?.data?.data;
  return (
    <Show isLoading={queryResult?.isLoading}>
      {record && (
        <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.5rem 1rem' }}>
          <dt><Text strong>_id</Text></dt>
          <dd>{record._id}</dd>
          {fields.map((f) => (
            <React.Fragment key={f.name}>
              <dt><Text strong>{f.name}</Text></dt>
              <dd>{renderCell(f, record[f.name])}</dd>
            </React.Fragment>
          ))}
          <dt><Text strong>createdAt</Text></dt>
          <dd>{record.createdAt && dayjs(record.createdAt).format('YYYY-MM-DD HH:mm')}</dd>
          <dt><Text strong>updatedAt</Text></dt>
          <dd>{record.updatedAt && dayjs(record.updatedAt).format('YYYY-MM-DD HH:mm')}</dd>
        </dl>
      )}
    </Show>
  );
}

function FieldFormItem({ field }) {
  return (
    <Form.Item
      key={field.name}
      label={field.name}
      name={field.name}
      valuePropName={field.type === 'boolean' ? 'checked' : 'value'}
      rules={field.required ? [{ required: true, message: `${field.name} is required` }] : []}
    >
      {fieldInput(field)}
    </Form.Item>
  );
}

export function ResourceCreate({ resourceName, fields }) {
  const { formProps, saveButtonProps } = useForm({ resource: resourceName });
  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        {fields
          .filter((f) => f.type !== 'file')
          .map((f) => (
            <FieldFormItem key={f.name} field={f} />
          ))}
      </Form>
    </Create>
  );
}

export function ResourceEdit({ resourceName, fields }) {
  const { formProps, saveButtonProps, queryResult } = useForm({ resource: resourceName });
  return (
    <Edit saveButtonProps={saveButtonProps} isLoading={queryResult?.isLoading}>
      <Form {...formProps} layout="vertical">
        {fields
          .filter((f) => f.type !== 'file')
          .map((f) => (
            <FieldFormItem key={f.name} field={f} />
          ))}
      </Form>
    </Edit>
  );
}
